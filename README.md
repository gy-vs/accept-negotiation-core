# accept-negotiation-core

纯 HTTP 内容协商库（TypeScript / Node.js 20，零运行时依赖）。根据请求的
`Accept`、`Accept-Language`、`Accept-Encoding`、`Accept-Charset`，从服务端候选
表示中选出最佳结果，并给出每个维度的完整解释（命中了哪条客户端范围、质量值、
淘汰原因）。不包含服务器、CLI 或页面。

```bash
npm install
npm test        # tsc 构建 + node:test（表驱动测试 + 属性测试）
```

## 快速上手

```ts
import { negotiate } from 'accept-negotiation-core';

const result = negotiate(
  [
    { mediaType: 'text/html;level=1', language: 'en-US', data: { id: 1 } },
    { mediaType: 'application/json', encoding: 'gzip', data: { id: 2 } },
  ],
  {
    accept: 'text/*;q=0.8, application/json',
    acceptLanguage: 'en;q=0.9',
    acceptEncoding: 'gzip, identity;q=0',
    // acceptCharset 缺失：与显式 "*" 是不同的状态
  },
  { weights: { media: 2, language: 1, encoding: 1, charset: 1 } },
);

if (result.ok) {
  result.selected.candidate;        // 胜出的候选（含 data 载荷）—— 本例为 id: 2
                                    // （id: 1 被 identity;q=0 淘汰）
  result.selected.score;            // 加权综合分 ∈ [0, 1]，本例为 1
  result.selected.dimensions[0];    // media 维度的解释
  // { state: 'matched', quality: 1, specificity: 2,
  //   matchedRange: 'application/json', matchedRangeIndex: 1,
  //   reason: 'matched media range "application/json" with q=1', ... }
} else {
  result.failure;                   // 'no-candidates' | 'all-candidates-excluded'
  result.eliminatedCounts;          // 每个维度各淘汰了多少候选
}
result.vary;                        // 实际参与选择的请求头
                                    // 本例为 ['Accept', 'Accept-Language', 'Accept-Encoding']
```

## API

- `negotiate(candidates, request?, options?)` — 执行协商。
  - `candidates: Candidate<T>[]`：服务端候选，输入顺序是最终决胜依据。
    `mediaType` 必填（具体类型，不允许通配符）；`language` / `encoding` /
    `charset` 可选；`data` 为不透明载荷，原样带回报告。
  - `request`：四个请求头的原始字符串；`null`/`undefined` 表示**缺失**
    （与显式 `*` 状态不同）。
  - `options.weights`：服务端配置的维度权重（有限数 ≥ 0，至少一个 > 0，
    默认全 1）。权重只影响打分；任一维度 q=0 仍然直接淘汰候选。
- `computeVary(candidates, request)` — 返回实际参与选择的请求头集合
  （规范大小写、固定顺序），可直接 `join(', ')` 写入 `Vary`。
- 解析器：`parseAccept` / `parseAcceptLanguage` / `parseAcceptEncoding` /
  `parseAcceptCharset` / `parseMediaType`，保留原始顺序（`index`）与原始
  文本（`raw`）。
- 错误：`NegotiationError` 基类；`NegotiationSyntaxError`（语法，含
  `subject` 定位）、`CandidateError`、`ConfigurationError`。

## 语义约定

**解析（严格校验）**

- 大小写：type/subtype、参数名、语言子标签、编码、字符集均按 RFC 大小写
  不敏感处理（比较小写化，`raw` 保留原文）；媒体类型参数值也按小写比较。
- 可选空白：允许列表元素与 `;` 周围的 SP/HTAB；拒绝 token 内部、`=` 两侧的空白。
- 重复参数：同一媒体范围内重复的参数名（含跨 q 前后）或重复 q → 语法错误。
- q 值：严格匹配 `qvalue` 文法（`0`、`0.xxx`、`1`、`1.000`，最多三位小数；
  `q=2`、`q=.5`、`q="0.5"`、`q= 0.5` 均拒绝）。
- 引号字符串支持转义；空列表元素按 `#rule` 忽略；`Accept-Charset` 按 `1#`
  要求至少一项，空值报错。

**维度匹配**

- 媒体：精确度（`*/*` < `type/*` < 完整类型）优先，其次范围内参数个数，
  再其次客户端顺序；范围内的每个参数都必须在候选中出现且值相等。
  最佳匹配范围的 q 即该维度质量；q=0 明确排除。
- 语言：RFC 4647 基本过滤——范围是标签的子标签前缀即匹配（`en` 匹配
  `en-US`，反向不行）；子标签越多特异度越高。
- 编码：遵循 RFC 9110——无内容编码的候选（identity）默认可接受，除非被
  `identity;q=0` 或（无更具体 identity 条目时的）`*;q=0` 排除；未列出且
  无 `*` 的编码不可接受；空的 `Accept-Encoding` 仅接受 identity。
- 字符集：显式条目 > `*` > 不可接受（q=0）。
- 候选未声明 language/charset 时，该维度为**中立**（q=1，
  `state: 'not-applicable'`），与显式匹配区分开。

**组合与决胜**

1. 任一维度 q=0 → 候选淘汰（与权重无关）；全部淘汰 → `ok: false`。
2. 综合分 = 四维质量的加权平均（缺失请求头按 q=1 计入）。
3. 依次决胜：综合分 → 总特异度 → 客户端顺序（按 media、language、
   encoding、charset 固定顺序逐维比较命中范围的下标）→ 服务端输入顺序。
   全程使用显式比较器，不依赖对象遍历顺序；除候选输入顺序外无不确定性
   （属性测试覆盖）。

**Vary**

只包含实际参与选择的请求头：头存在且该维度能区分候选（language/charset
维度要求至少一个候选声明了对应属性；media/encoding 总是参与）。缺失的
请求头不出现在 Vary 中。

## 项目结构

```
src/
  index.ts      公共导出
  negotiate.ts  协商主流程（评估、打分、决胜）
  match.ts      四个维度的匹配器
  parse.ts      四个 Accept-* 解析器 + 候选媒体类型解析
  syntax.ts     token / OWS / quoted-string / qvalue 等底层文法
  vary.ts       Vary 计算
  types.ts      公共类型
  errors.ts     错误层级
test/
  parse.test.ts     解析器表驱动测试
  negotiate.test.ts 协商语义表驱动测试
  property.test.ts  属性测试（种子随机：候选顺序之外的确定性、结果不变量、
                    缺失 vs 显式星号、解析器鲁棒性）
```
