# 交付说明：分隔符 `auto` 字面量修复与两侧自动发现口径收敛（t116）

## 一、根因结论

采集管道在解析（`csv-parse`）与回写（`csv-stringify`）两侧都宣称支持分隔符“自动形态”，但实现里**没有任何一处把字符串 `"auto"` 识别为“自动发现”的开关**，于是同一条配置项的两种写法走向了互相矛盾的分支：

- **解析侧**：自动形态由独立选项 `delimiter_auto`（布尔/配置对象）控制。当配置写成 `delimiter: "auto"` 时，`normalize_options` 把 `"auto"` 当成一个普通的多字符字符串分隔符，经 `Buffer.from("auto")` 转成 4 字节的字面量分隔符。真实报文里不存在连续的 `a u t o`，于是每一行都切不出列，多列报文被并成单列，脏数据静默入库。
- **回写侧**：根本没有 `delimiter_auto` 选项，`delimiter: "auto"` 同样被当作普通字符串，逐字作为列分隔符输出，列值被粘成 `aautobautoc` 这样的串。
- **留空形态**：解析侧留空走的是 `delimiter_auto` 默认关闭后的逗号默认值；而在显式打开 `delimiter_auto: true` 时才走自动发现。也就是说，“自动发现”这条能力一直存在，只是只认布尔/对象开关，不认字面 `auto`，导致同一项配置两种写法口径自相矛盾。

此外，两侧即便都进入自动发现，实现也不一致：解析侧在原始字节缓冲上、以 `delimiter_auto.size`（默认 2048 字节）为采样窗口做频次/标准差评分；回写侧则完全没有对应实现。同一份多源报文在两侧可能得出不同分隔形态。

## 二、两种写法的判定依据（修复后统一）

| 配置写法                                           | 解析侧 `csv-parse`                                              | 回写侧 `csv-stringify`                                    |
| -------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `delimiter: "auto"`（或内容为 `auto` 的 Buffer）   | 等价于 `delimiter_auto: true`，进入自动发现                     | 进入自动发现（内部非枚举标记，不改变公开 `options` 形状） |
| 留空（`undefined`/`null`）                         | **保持既有行为不变**：`delimiter_auto` 默认关闭，分隔符默认逗号 | **保持既有行为不变**：分隔符默认逗号，不做发现            |
| 显式具体分隔符（如 `";"`、`[";",","]`、Buffer 等） | **逐字不回退**：完全沿用原归一化与解析逻辑                      | **逐字不回退**：完全沿用原归一化与序列化逻辑              |

判定依据：

1. 字面 `auto` 与显式具体分隔符是互斥意图。归一化阶段先于“字符串转 Buffer”拦截 `auto`，避免它再被当成 4 字符字面量。
2. 留空的逗号默认值被既有测试锁定（`normalize_options({}).delimiter === [Buffer.from(",")]`），且大量既有行为依赖它，因此**留空不改变语义**；要自动发现必须显式表达（字面 `auto` 或 `delimiter_auto: true`）。
3. `csv-parse` 中 `delimiter: "auto"` 与 `delimiter_auto: true` 现在收敛到同一条自动发现代码路径，两种写法结果完全一致。

## 三、统一后的采样窗口与判定口径

两侧现在共用同一套发现算法（因 `csv-parse` 与 `csv-stringify` 互不依赖，代码在两个包内同构镜像，注释互相标注必须同步修改）：

- **采样窗口**：统一为前 **2048 个单位**（解析侧为字节、回写侧为 cast 后的字符），常量 `delimiter_discover_default_size = 2048`。解析侧流式场景在窗口超限时触发发现，并剥除可能被截断的最后一条不完整记录再评分；`end` 时数据完整则不剥除。
- **候选评分**：沿用历史公式 `score = (total - std) * (preferred[char_code] || 1)`，其中 `total` 为字符出现总次数、`std` 为各记录出现次数的标准差、`preferred` 为 `,`/`\t`(1.8)、`;`/空格(1.6)、`:`(1.5)、`.`/`/`(1.4) 的偏好权重。回写侧的偏好表、评分函数与解析侧逐字一致。
- **可信判定（新增，两侧一致）**：仅靠频次无法区分“分隔符”和“恰好每行都出现的内容字符”（例如 `alpha/beta/gamma` 里每行都含字母 `a`）。因此在选出最高分字符后，追加**结构性判据** `delimiter_structural_match`：用该字符切分每条采样记录，所有记录必须切出**相同且 ≥2 的字段数**。真正的列分隔符会让每一行列数一致；内容字符做不到。至少需要 2 条完整记录可比较（解析侧在极小窗口只剩 1 条完整记录时放宽为 1 条，但仍要求能切成 ≥2 字段）。换行符 `\n`、`\r` 与 NUL 永不作为候选。
- **收敛保证**：同一份多源报文喂给两侧的评分函数，胜者字符码与 `trusted` 结论一致（见 `packages/csv/test/option.delimiter.auto_literal.js` 的对照用例）。

## 四、无法发现时的回退策略及理由

- **解析侧**：自动发现不可信时，抛 `CSV_DELIMITER_NOT_DISCOVERED` 错误，拒绝静默产出单列脏数据。
- **回写侧**：自动发现不可信时，抛 `CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE` 错误，拒绝把列值粘成一串。
- **空输入例外（刻意保留）**：解析侧空输入仍返回 `[]`，回写侧空输入仍返回 `""`/仅表头。理由：空数据没有“错误分隔符”可言，这是两侧被既有测试锁定的历史行为，保留它不影响脏数据防护，也避免给无数据管道制造伪错误。

**为什么选择“报错”而不是“退回逗号默认值”**：本缺陷的危害正是“静默”——错误分隔符不报错，脏数据一路入库、下游按列取数全错。若不可发现时悄悄退回逗号，单列/无分隔报文会被静默接受，等于保留了同一类静默故障。显式报错把“无法判定”变成一个可观测、可处置的信号，调用方改用显式 `delimiter` 即可。这也符合要求中“无法发现时的既有报错不回退”：原本 `delimiter_auto: true` 在不可信数据上最终会触发的字段长度不一致错误，现在提前为语义更明确的发现失败错误，仍然是失败、不会静默成功。

## 五、明确不回退的既有行为

- 留空 → 逗号默认值（两侧）。
- 显式具体分隔符 → 逐字保留，归一化与（解析/序列化）主流程一字未改。
- `delimiter_discover` 工具函数的历史返回值保持不变：仍返回最高分字符；新增的 `trusted` 仅作为附加字段，由调用方决定是否拦截。
- 空输入、显式 `delimiter_auto: false`、自定义 `score`/`preferred`/`size` 等既有用法全部保留。
- 回写侧自动发现配置以**不可枚举属性** `delimiter_auto` 承载，`Object.keys(options)` 与历史完全一致，不破坏公开选项形状与既有断言。

## 六、改动文件

源码：

- `packages/csv-parse/lib/api/normalize_options.js`：拦截字面 `auto`，转入自动形态。
- `packages/csv-parse/lib/utils/delimiter_discover.js`：抽出可复用的 `delimiter_records`/`delimiter_score`，新增结构判据、可信标记与统一常量。
- `packages/csv-parse/lib/api/index.js`：接入可信判定与 `CSV_DELIMITER_NOT_DISCOVERED`，处理流式截断。
- `packages/csv-stringify/lib/utils/delimiter_discover.js`（新增）：与解析侧同构的发现实现。
- `packages/csv-stringify/lib/api/normalize_options.js`：识别字面 `auto`，挂载内部发现配置。
- `packages/csv-stringify/lib/api/index.js`、`lib/index.js`、`lib/sync.js`：记录缓冲、窗口收敛、发现失败报错与 flush 收尾。
- 两侧 `*.d.ts`：`delimiter` 类型补充 `"auto"` 字面量并补文档注释。
- 三个包的 `dist/` 已用 rollup 重新构建并同步类型声明，保证 `require`/bundle 入口与 `lib` 行为一致。

测试（三种写法 × 解析/回写两侧 × 可发现/不可发现）：

- `packages/csv-parse/test/option.delimiter.auto_literal.js`（15 例）
- `packages/csv-stringify/test/option.delimiter.auto_literal.js`（14 例）
- `packages/csv/test/option.delimiter.auto_literal.js`（12 例，端到端两侧收敛矩阵）

## 七、测试结果

- `csv-parse`：575 passing（含新增 15 例），2 pending。
- `csv-stringify`：220 passing（含新增 14 例），1 pending。
- `csv`：38 passing（含新增 12 例）。
- 两侧 `tsc --noEmit` 类型检查通过；改动源码 ESLint 无新增实质问题（仓库在 Windows 检出下既有的 CRLF/prettier 行尾噪音与本次改动无关，未改动文件同样存在）。
- 注：两个包的 `test/samples.js` 在当前 Windows 环境存在既有路径缺陷（`new URL().pathname` 拼出 `D:\D:\...`），在本次改动前后均无法运行，与本修复无关，运行全量时以 `--ignore test/samples.js` 排除。
