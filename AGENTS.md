# 项目规范

本项目（百炼平台模型统计 Tampermonkey 脚本）遵循以下四条硬规则。所有后续修改必须严格保持一致。

## 1. Fail Fast，禁止兜底掩盖问题

直接按明确路径访问数据，让上游结构变化立刻抛错。

- 禁止 `obj && obj.data && obj.data.x` 这种链式判空。想访问就直接 `obj.data.x`。
- 禁止 `try/catch` 吞掉解析错误（仅在明确 recovery 语义时使用）。
- 禁止 `?.` / `||` 兜底出一个假的成功状态。
- 存储读取（如 `JSON.parse(GM_getValue(...))`）不要 try/catch，脏数据必须暴露。

反例：
```js
const list = obj?.data?.DataV2?.data?.data?.list || [];
if (!list.length) return;
```

正例：
```js
const dataBlock = payload.data.DataV2.data.data;
const list = dataBlock.list;
if (!list || list.length === 0) return;
```

## 2. URL 匹配用精确参数，不做结构探测

拦截目标接口时，用**接口标识参数**做子串匹配，一次到位。

- 用 `api=zeldaEasy.broadscope-bailian.app-control.list` 这种参数级 key。
- 禁止匹配 `/data/api.json` 这种网关级路径然后再去响应体里递归探测结构，这是掩盖需求不明。
- 目标变了就换 key，不要泛化。

反例：
```js
if (url.includes('/data/api.json')) {
    const block = findAnyListLike(payload); // 递归猜
}
```

正例：
```js
const TARGET_API_PARAM = 'api=zeldaEasy.broadscope-bailian.app-control.list';
if (url.includes(TARGET_API_PARAM)) { ... }
```

## 3. XHR 拦截必须区分 responseType

`XMLHttpRequest` 的响应体在不同 `responseType` 下入口不同，读错入口会拿到空。

- `responseType === 'json'` → 读 `this.response`（已是对象）
- 其他情况 → 读 `this.responseText`（字符串）
- 不要无脑 `this.responseText`。

正例：
```js
xhr.addEventListener('load', () => {
    const raw = this.responseType === 'json' ? this.response : this.responseText;
    handleResponsePayload(raw);
});
```

## 4. UI 用纯 DOM 构建，禁止 innerHTML

统一走 `ce(tag, attrs, children)` 工厂函数，杜绝字符串拼接注入。

- 禁止 `innerHTML = \`<div>${x}</div>\``，即使 x 是自己的数据。
- 禁止手写 `escapeHtml` 再拼字符串——那是绕过规则。
- 清空节点用 `el.textContent = ''`，不用 `el.innerHTML = ''`。
- 事件绑定通过 `ce` 的 `onXxx` 属性或 `addEventListener`，不用 `onclick="..."`。

反例：
```js
tbody.innerHTML = list.map(x => `<tr><td>${escapeHtml(x.name)}</td></tr>`).join('');
```

正例：
```js
tbody.textContent = '';
list.forEach(x => {
    tbody.appendChild(ce('tr', {}, [ ce('td', { textContent: x.name }) ]));
});
```

---

## 何时可以违反

不能。这些规则的价值在于一致性，一次例外就会长成一片。
如果规则确实妨碍了新需求，先改规则再改代码，不要偷偷放行。
