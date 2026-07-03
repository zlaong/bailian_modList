// ==UserScript==
// @name         百炼平台 - 智能体/工作流模型统计 (严格规范重构版)
// @namespace    https://github.com/anomalyco/bailian-model-stats
// @version      4.0.0
// @description  被动精确拦截百炼网关，自动补齐工作流详情，纯 DOM UI，严格 Fail Fast
// @match        *://bailian-cs.console.aliyun.com/*
// @match        *://bailian.console.aliyun.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      help.aliyun.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // 常量 (规则 2：URL 用精确参数)
    // ============================================================
    const TARGET_LIST_API = 'api=zeldaEasy.broadscope-bailian.app-control.list';
    const TARGET_DETAIL_API = 'api=zeldaEasy.broadscope-bailian.app-orchestra-flow.getConfig';
    const TARGET_WORKSPACE_API = 'api=zeldaEasy.bailian-dash-workspace.space.listWorkspaces4Agent';
    // 模型下线机制说明页 nodeId
    const DEPRECATION_DOC_URL = 'https://help.aliyun.com/help/json/document_detail.json?nodeId=2879055&website=cn&language=zh';
    const STORAGE_KEY = 'bailian_model_stats_apps';
    const WORKSPACES_KEY = 'bailian_model_stats_workspaces';
    const DEPRECATION_KEY = 'bailian_model_stats_deprecation';
    const LOG_PREFIX = '[百炼模型统计]';
    const DETAIL_CONCURRENCY = 4;
    const SCAN_PAGE_SIZE = 30;
    const SCAN_REQUEST_DELAY = 200; // ms，避免过快触发风控
    // 下架数据缓存有效期（24 小时）
    const DEPRECATION_TTL = 24 * 3600 * 1000;

    // ============================================================
    // 纯 DOM 构建 (规则 4)
    // ============================================================
    function ce(tag, attributes = {}, children = []) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'style') Object.assign(el.style, value);
            else if (key === 'className') el.className = value;
            else if (key === 'textContent') el.textContent = value;
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.toLowerCase().substring(2), value);
            else el.setAttribute(key, value);
        }
        children.forEach(child => {
            if (child instanceof Node) el.appendChild(child);
            else if (child !== undefined && child !== null) el.appendChild(document.createTextNode(String(child)));
        });
        return el;
    }

    // ============================================================
    // 存储 (规则 1：Fail Fast，脏数据必须暴露)
    // ============================================================
    const store = {
        getApps() {
            return JSON.parse(GM_getValue(STORAGE_KEY, '{}'));
        },
        setApps(apps) {
            GM_setValue(STORAGE_KEY, JSON.stringify(apps));
        },
        mergeList(list) {
            const apps = store.getApps();
            let added = 0;
            list.forEach(item => {
                if (!apps[item.code]) added++;
                const existing = apps[item.code] || {};
                apps[item.code] = {
                    code: item.code,
                    name: item.name,
                    description: item.description,
                    type: item.type,
                    sub_type: item.sub_type,
                    source: item.source,
                    scope: item.scope,
                    status: item.status,
                    tenantId: item.tenantId != null ? item.tenantId : existing.tenantId,
                    gmt_create: item.gmt_create,
                    gmt_modified: item.gmt_modified,
                    config: extractConfigSummary(item.config),
                    flow_models: existing.flow_models,
                    flow_fetched_at: existing.flow_fetched_at,
                    _capturedAt: Date.now(),
                    _lastSeenAt: Date.now()
                    // 见到即清除 deleted 标记
                };
            });
            store.setApps(apps);
            return added;
        },
        updateFlowDetail(code, flowModels) {
            const apps = store.getApps();
            const app = apps[code];
            app.flow_models = flowModels;
            app.flow_fetched_at = Date.now();
            store.setApps(apps);
        },
        // 完整扫描完成后调用，把该空间"存在但未见"的 code 标记为 deleted，见到的清标记
        applyScanResult(tenantId, seenCodes) {
            const apps = store.getApps();
            const tid = String(tenantId);
            let markedDeleted = 0;
            let restored = 0;
            Object.values(apps).forEach(app => {
                if (String(app.tenantId) !== tid) return;
                if (seenCodes.has(app.code)) {
                    if (app.deleted) {
                        delete app.deleted;
                        delete app.deletedAt;
                        restored++;
                    }
                } else {
                    if (!app.deleted) {
                        app.deleted = true;
                        app.deletedAt = Date.now();
                        markedDeleted++;
                    }
                }
            });
            store.setApps(apps);
            return { markedDeleted, restored };
        },
        purgeDeleted() {
            const apps = store.getApps();
            let purged = 0;
            Object.keys(apps).forEach(code => {
                if (apps[code].deleted) {
                    delete apps[code];
                    purged++;
                }
            });
            store.setApps(apps);
            return purged;
        },
        clear() {
            GM_deleteValue(STORAGE_KEY);
        },
        // 空间映射：{ tenantId: { agentName, workspaceId, defaultAgent, ... } }
        getWorkspaces() {
            return JSON.parse(GM_getValue(WORKSPACES_KEY, '{}'));
        },
        setWorkspaces(map) {
            GM_setValue(WORKSPACES_KEY, JSON.stringify(map));
        },
        mergeWorkspaces(list) {
            const map = store.getWorkspaces();
            list.forEach(ws => {
                map[ws.tenantId] = {
                    tenantId: ws.tenantId,
                    agentName: ws.agentName,
                    agentKey: ws.agentKey,
                    workspaceId: ws.workspaceId,
                    workspaceRegion: ws.workspaceRegion,
                    workspaceRegionName: ws.workspaceRegionName,
                    endpoint: ws.endpoint,
                    defaultAgent: ws.defaultAgent,
                    _capturedAt: Date.now()
                };
            });
            store.setWorkspaces(map);
        }
    };

    function extractConfigSummary(config) {
        const summary = {
            model: config.model,
            selectedType: config.selectedType,
            hasInstruction: config.instruction !== undefined || config.instructions !== undefined
        };

        if (config.web_search_config !== undefined) {
            summary.web_search = {
                enabled: config.web_search_config.enable_web_search,
                model: config.web_search_config.model
            };
        }

        const rerankModels = new Set();
        if (config.ragConfig !== undefined && config.ragConfig.scene_config !== undefined) {
            Object.values(config.ragConfig.scene_config).forEach(sc => {
                if (sc.rerank !== undefined && sc.rerank.enable_rerank === true) {
                    rerankModels.add(sc.rerank.model);
                }
            });
            if (config.ragConfig.scene_config.web !== undefined && config.ragConfig.scene_config.web.enable_web_search === true) {
                summary.web_search_scene = config.ragConfig.scene_config.web.model;
            }
        }
        summary.rerank_models = Array.from(rerankModels);

        if (config.model_config !== undefined) {
            summary.enable_thinking = config.model_config.enable_thinking;
            summary.temperature = config.model_config.temperature;
        } else if (config.parameterVO !== undefined) {
            summary.enable_thinking = config.parameterVO.enable_thinking;
            summary.temperature = config.parameterVO.temperature;
        }

        return summary;
    }

    // ============================================================
    // 详情解析：从 nodes 中提取 LLM 模型 (Fail Fast)
    // ============================================================
    function extractFlowModels(configJsonStr) {
        // configJsonStr 是 payload.data.DataV2.data.data.config，是 JSON 字符串
        const flowConfig = JSON.parse(configJsonStr);
        const nodes = flowConfig.nodes;
        const models = [];
        nodes.forEach(node => {
            if (node.type !== 'LLM') return;
            // 直接按明确路径访问，缺失就崩
            const mc = node.config.nodeParam.modelConfig;
            models.push({
                nodeId: node.id,
                nodeName: node.name,
                modelId: mc.modelId,
                modelName: mc.modelName
            });
        });
        return models;
    }

    // ============================================================
    // 模型下架数据抓取与解析
    // 数据源：阿里帮助中心「模型下线机制说明」页面（nodeId=2879055）
    // 结构：HTML 内多个 <table>，每张表 4 列（类别 / 模型名称 / 下线时间 / 替代模型）
    // 关键点：模型名称一列有 rowspan（第一行合并了同批多个模型）
    // ============================================================
    function parseTableCells(rowHtml) {
        const cells = [];
        const re = /<td([^>]*)>([\s\S]*?)<\/td>/g;
        let m;
        while ((m = re.exec(rowHtml)) !== null) {
            const attrs = m[1];
            const inner = m[2];
            const rs = attrs.match(/rowspan="(\d+)"/);
            const rowspan = rs ? parseInt(rs[1], 10) : 1;
            const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            cells.push({ text, rowspan });
        }
        return cells;
    }

    function parseDeprecationTable(tableHtml, columns) {
        const rowMatches = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
        if (rowMatches.length <= 1) return [];
        const dataRows = rowMatches.slice(1);
        const carry = Array.from({ length: columns }, () => ({ value: null, remaining: 0 }));
        const result = [];
        dataRows.forEach(rowHtml => {
            const cells = parseTableCells(rowHtml);
            const out = new Array(columns).fill(null);
            let cursor = 0;
            for (let col = 0; col < columns; col++) {
                if (carry[col].remaining > 0) {
                    out[col] = carry[col].value;
                    carry[col].remaining--;
                } else {
                    if (cursor >= cells.length) continue;
                    const cell = cells[cursor++];
                    out[col] = cell.text;
                    if (cell.rowspan > 1) {
                        carry[col] = { value: cell.text, remaining: cell.rowspan - 1 };
                    }
                }
            }
            result.push(out);
        });
        return result;
    }

    function parseDeprecationDoc(contentHtml) {
        const tables = contentHtml.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
        const map = {};
        tables.forEach(t => {
            const rows = parseDeprecationTable(t, 4);
            rows.forEach(row => {
                const [category, modelName, dateStr, alt] = row;
                if (!modelName || !dateStr) return;
                const m = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
                if (!m) return;
                const offlineAt = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
                modelName.split(/\s*又称\s*/).forEach(name => {
                    const key = name.trim();
                    if (!key) return;
                    if (map[key] && map[key].offlineAt <= offlineAt) return;
                    map[key] = { offlineAt, alternative: alt || '', category: category || '' };
                });
            });
        });
        return map;
    }

    function getDeprecationCache() {
        const raw = GM_getValue(DEPRECATION_KEY, null);
        if (!raw) return null;
        return JSON.parse(raw);
    }

    function setDeprecationCache(data) {
        GM_setValue(DEPRECATION_KEY, JSON.stringify(data));
    }

    function fetchDeprecationDoc(force) {
        return new Promise((resolve, reject) => {
            const cache = getDeprecationCache();
            if (!force && cache && (Date.now() - cache.fetchedAt) < DEPRECATION_TTL) {
                resolve(cache);
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: DEPRECATION_DOC_URL,
                onload(resp) {
                    const payload = JSON.parse(resp.responseText);
                    const contentHtml = payload.data.content;
                    const map = parseDeprecationDoc(contentHtml);
                    const record = {
                        fetchedAt: Date.now(),
                        docModifiedAt: payload.data.lastModifiedTime,
                        models: map
                    };
                    setDeprecationCache(record);
                    console.log(`${LOG_PREFIX} 下架数据已刷新，条目数 ${Object.keys(map).length}`);
                    resolve(record);
                },
                onerror(err) { reject(new Error('下架文档请求失败: ' + (err && err.error))); },
                ontimeout() { reject(new Error('下架文档请求超时')); }
            });
        });
    }

    // 计算某模型的下架信息
    // level: 'offline' (已下线，最紧急) / 'critical' (≤7) / 'warning' (≤15) / 'notice' (≤30) / 'future' (>30，仅提示) / null (不在列表)
    function getDeprecationInfoForModel(modelId, cache) {
        if (!cache || !cache.models) return null;
        const info = cache.models[modelId];
        if (!info) return null;
        const daysLeft = Math.floor((info.offlineAt - Date.now()) / 86400000);
        let level;
        if (daysLeft < 0) level = 'offline';
        else if (daysLeft <= 7) level = 'critical';
        else if (daysLeft <= 15) level = 'warning';
        else if (daysLeft <= 30) level = 'notice';
        else level = 'future';
        return {
            daysLeft,
            offlineAt: info.offlineAt,
            alternative: info.alternative,
            category: info.category,
            level
        };
    }

    // 计算某个 app 最紧急的下架等级（跨该 app 涉及的所有模型）
    function getMostUrgentDeprecation(app, cache) {
        if (!cache || !cache.models) return null;
        const models = collectModels(app);
        let worst = null;
        // offline 最高，critical 次之
        const rank = { offline: 4, critical: 3, warning: 2, notice: 1, future: 0 };
        models.forEach(m => {
            const info = getDeprecationInfoForModel(m.model, cache);
            if (!info) return;
            if (!worst || rank[info.level] > rank[worst.level]) {
                worst = Object.assign({ modelId: m.model, role: m.role }, info);
            }
        });
        // future 不算风险
        if (worst && worst.level === 'future') return null;
        return worst;
    }

    // ============================================================
    // 拦截 (规则 3：XHR 区分 responseType)
    // ============================================================
    const state = {
        lastCaptureAt: 0,
        latestTotal: 0,
        latestPageNo: 0,
        sessionAdded: 0,
        // 网关请求模板：从任一网关请求 body 里派生
        // { baseUrl, method, headers, secToken, region, cornerstoneParam, currentTenantId, capturedAt }
        gatewayTemplate: null,
        // 详情抓取运行时状态
        detailRunning: false,
        detailProgress: { done: 0, total: 0, failed: 0 },
        // 全量扫描运行时状态
        scanRunning: false,
        scanProgress: null,
        onDataUpdate: null
    };

    function handleListResponse(rawData) {
        const payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        const dataBlock = payload.data.DataV2.data.data;
        const list = dataBlock.list;
        if (!list || list.length === 0) return;

        const before = Object.keys(store.getApps()).length;
        store.mergeList(list);
        const after = Object.keys(store.getApps()).length;
        const added = after - before;

        state.latestTotal = dataBlock.total || state.latestTotal;
        state.latestPageNo = dataBlock.pageNo || state.latestPageNo;
        state.lastCaptureAt = Date.now();
        state.sessionAdded += added;

        console.log(`${LOG_PREFIX} 列表拦截 page=${dataBlock.pageNo} 本页${list.length}条 新增${added} 已存${after}`);
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();

        // 拦截列表后尝试自动补齐工作流详情
        autoFetchMissingDetails();
    }

    function handleDetailResponse(rawData) {
        const payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        const dataBlock = payload.data.DataV2.data.data;
        // dataBlock.applicationDTO.code 是 appCode，dataBlock.config 是 JSON 字符串
        const appCode = dataBlock.applicationDTO.code;
        const flowModels = extractFlowModels(dataBlock.config);

        const apps = store.getApps();
        if (!apps[appCode]) {
            // 详情比列表先到，先塞占位记录，等列表拦截时会补齐基础字段
            console.log(`${LOG_PREFIX} 详情先于列表到达，appCode=${appCode}`);
            return;
        }
        store.updateFlowDetail(appCode, flowModels);
        console.log(`${LOG_PREFIX} 详情拦截 appCode=${appCode} LLM节点数=${flowModels.length}`);
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
    }

    function handleWorkspaceResponse(rawData) {
        const payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        // 响应结构：data.DataV2.data.data.data 是数组
        const list = payload.data.DataV2.data.data.data;
        if (!Array.isArray(list) || list.length === 0) return;
        store.mergeWorkspaces(list);
        console.log(`${LOG_PREFIX} 空间列表拦截 数量=${list.length}`);
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
    }

    // ------ fetch hook ------
    const _fetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        const method = (init && init.method) || 'GET';
        const p = _fetch.apply(this, arguments);

        if (url && url.includes(TARGET_LIST_API)) {
            // 从列表请求 body 提取网关模板
            if (init && init.body) captureGatewayTemplate(url, method, init.headers, init.body);
            p.then(resp => resp.clone().text().then(handleListResponse));
        } else if (url && url.includes(TARGET_DETAIL_API)) {
            // 用户手动点开的详情也拿来用（模板 fallback + 直接入库）
            if (init && init.body) captureGatewayTemplate(url, method, init.headers, init.body);
            p.then(resp => resp.clone().text().then(handleDetailResponse));
        } else if (url && url.includes(TARGET_WORKSPACE_API)) {
            if (init && init.body) captureGatewayTemplate(url, method, init.headers, init.body);
            p.then(resp => resp.clone().text().then(handleWorkspaceResponse));
        }
        return p;
    };

    // ------ XHR hook ------
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    const _setHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
        this.__bl_url = url;
        this.__bl_method = method;
        this.__bl_headers = {};
        return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (this.__bl_headers) this.__bl_headers[k] = v;
        return _setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this.__bl_url;
        if (url && url.includes(TARGET_LIST_API)) {
            if (body) captureGatewayTemplate(url, this.__bl_method, this.__bl_headers, body);
            this.addEventListener('load', () => {
                const raw = this.responseType === 'json' ? this.response : this.responseText;
                handleListResponse(raw);
            });
        } else if (url && url.includes(TARGET_DETAIL_API)) {
            if (body) captureGatewayTemplate(url, this.__bl_method, this.__bl_headers, body);
            this.addEventListener('load', () => {
                const raw = this.responseType === 'json' ? this.response : this.responseText;
                handleDetailResponse(raw);
            });
        } else if (url && url.includes(TARGET_WORKSPACE_API)) {
            if (body) captureGatewayTemplate(url, this.__bl_method, this.__bl_headers, body);
            this.addEventListener('load', () => {
                const raw = this.responseType === 'json' ? this.response : this.responseText;
                handleWorkspaceResponse(raw);
            });
        }
        return _send.apply(this, arguments);
    };

    // ============================================================
    // 网关模板：从任意一次网关请求 body 里提取 sec_token / region / cornerstoneParam
    // 这些字段所有百炼网关接口共用，可直接派生任意 api 调用
    // ============================================================
    function captureGatewayTemplate(url, method, headers, body) {
        if (typeof body !== 'string') {
            console.log(`${LOG_PREFIX} body 非字符串，跳过模板捕获`);
            return;
        }

        // form-urlencoded: params=<encoded_json>&region=xxx&sec_token=xxx
        const form = new URLSearchParams(body);
        const paramsJsonStr = form.get('params');
        const region = form.get('region');
        const secToken = form.get('sec_token');
        if (!paramsJsonStr || !region || !secToken) {
            console.log(`${LOG_PREFIX} body 缺少必要字段（params/region/sec_token），跳过`);
            return;
        }

        // 直接按明确路径抓 cornerstoneParam。列表接口它在 params.cornerstoneParam，
        // 详情接口在 params.Data.cornerstoneParam。都取一次，Fail Fast。
        const paramsObj = JSON.parse(paramsJsonStr);
        const cornerstoneParam = paramsObj.cornerstoneParam || (paramsObj.Data && paramsObj.Data.cornerstoneParam);
        if (!cornerstoneParam) {
            console.log(`${LOG_PREFIX} 未找到 cornerstoneParam，跳过`);
            return;
        }

        state.gatewayTemplate = {
            // 从 url 剥掉 api=xxx 参数，得到网关根 URL 模板
            baseUrl: url.replace(/&?api=[^&]+/, '').replace(/&_v=[^&]+/, ''),
            method: method || 'POST',
            headers: normalizeHeaders(headers),
            region,
            secToken,
            cornerstoneParam,
            // switchAgent 是当前活动的 tenantId，可能是 number
            currentTenantId: cornerstoneParam.switchAgent != null ? String(cornerstoneParam.switchAgent) : null,
            capturedAt: Date.now()
        };
        console.log(`${LOG_PREFIX} 已捕获网关模板 tenant=${state.gatewayTemplate.currentTenantId} secToken=${secToken.slice(0, 8)}...`);
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
    }

    function normalizeHeaders(headers) {
        const out = {};
        if (!headers) return out;
        if (headers instanceof Headers) {
            headers.forEach((v, k) => (out[k] = v));
        } else if (typeof headers === 'object') {
            Object.assign(out, headers);
        }
        // 保证 content-type 正确
        const hasCT = Object.keys(out).some(k => k.toLowerCase() === 'content-type');
        if (!hasCT) out['Content-Type'] = 'application/x-www-form-urlencoded';
        return out;
    }

    // 用网关模板派生一次 getConfig 请求，主动拉指定 appCode 的工作流详情
    async function fetchDetailForApp(appCode) {
        const tpl = state.gatewayTemplate;
        if (!tpl) throw new Error('没有网关模板');

        // 构造详情 URL：网关根 URL + api=getConfig + _v=undefined
        const detailUrl = tpl.baseUrl
            + (tpl.baseUrl.indexOf('?') === -1 ? '?' : '&')
            + 'api=zeldaEasy.broadscope-bailian.app-orchestra-flow.getConfig&_v=undefined';

        // 克隆 cornerstoneParam，替换 feURL 中的 appCode 引用
        const cornerstone = Object.assign({}, tpl.cornerstoneParam);
        if (cornerstone.feURL) {
            cornerstone.feURL = cornerstone.feURL.replace(
                /app-work-flow\/[a-f0-9]+/,
                'app-work-flow/' + appCode
            ).replace(
                /#\/app-center(?!\/app-work-flow)/,
                '#/app-center/app-work-flow/' + appCode
            );
        }

        // 详情 body 结构：{Api, V, Data: {appCode, cornerstoneParam}}
        const paramsObj = {
            Api: 'zeldaEasy.broadscope-bailian.app-orchestra-flow.getConfig',
            V: '1.0',
            Data: {
                appCode,
                cornerstoneParam: cornerstone
            }
        };
        const form = new URLSearchParams();
        form.set('params', JSON.stringify(paramsObj));
        form.set('region', tpl.region);
        form.set('sec_token', tpl.secToken);

        const resp = await _fetch(detailUrl, {
            method: tpl.method,
            credentials: 'include',
            headers: tpl.headers,
            body: form.toString()
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        handleDetailResponse(text);
    }

    // 并发池：从 items 里逐个消费，最多 concurrency 个在飞
    async function runPool(items, concurrency, worker) {
        let idx = 0;
        async function next() {
            while (idx < items.length) {
                const cur = items[idx++];
                await worker(cur);
            }
        }
        await Promise.all(Array.from({ length: concurrency }, next));
    }

    async function fetchAllMissingDetails() {
        if (state.detailRunning) {
            console.log(`${LOG_PREFIX} 详情抓取已在进行`);
            return;
        }
        if (!state.gatewayTemplate) {
            throw new Error('尚未捕获到网关模板。请先浏览一次"我的应用"列表。');
        }

        // 只处理当前活动空间的 app（详情接口是空间隔离的，跨空间拉会 401）
        const currentTid = state.gatewayTemplate.currentTenantId;
        const apps = Object.values(store.getApps());
        const targets = apps.filter(a => {
            if (a.type !== 7 || a.flow_models || a.deleted) return false;
            if (currentTid && String(a.tenantId) !== currentTid) return false;
            return true;
        }).map(a => a.code);
        if (targets.length === 0) {
            console.log(`${LOG_PREFIX} 没有需要补齐的工作流（当前空间 ${currentTid}）`);
            return;
        }
        console.log(`${LOG_PREFIX} 准备补齐 ${targets.length} 个工作流（空间 ${currentTid}）`);

        state.detailRunning = true;
        state.detailProgress = { done: 0, total: targets.length, failed: 0 };
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();

        await runPool(targets, DETAIL_CONCURRENCY, async (code) => {
            try {
                await fetchDetailForApp(code);
            } catch (e) {
                console.warn(`${LOG_PREFIX} 详情抓取失败 code=${code}`, e);
                state.detailProgress.failed++;
            } finally {
                state.detailProgress.done++;
                if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
            }
        });

        state.detailRunning = false;
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
        console.log(`${LOG_PREFIX} 详情抓取完成 done=${state.detailProgress.done} failed=${state.detailProgress.failed}`);
    }

    // 列表拦截后触发（有模板才跑，静默）
    function autoFetchMissingDetails() {
        if (!state.gatewayTemplate) return;
        if (state.detailRunning) return;
        fetchAllMissingDetails().catch(e => console.warn(`${LOG_PREFIX} 自动补齐失败`, e));
    }

    // ============================================================
    // 全量扫描：遍历所有空间的所有列表页，识别已删除的应用
    // ============================================================
    // 派生一次 list 请求（指定 tenantId + pageNo），返回响应 payload
    async function fetchListPageForTenant(tenantId, pageNo) {
        const tpl = state.gatewayTemplate;
        if (!tpl) throw new Error('没有网关模板');

        const listUrl = tpl.baseUrl
            + (tpl.baseUrl.indexOf('?') === -1 ? '?' : '&')
            + 'api=zeldaEasy.broadscope-bailian.app-control.list&_v=undefined';

        // 克隆 cornerstoneParam，改 switchAgent + feURL
        const cornerstone = Object.assign({}, tpl.cornerstoneParam);
        cornerstone.switchAgent = Number(tenantId);
        if (cornerstone.feURL) {
            cornerstone.feURL = cornerstone.feURL.replace(
                /switchAgent=\d+/,
                'switchAgent=' + tenantId
            );
        }

        // 列表 body 结构：{Api, V, Data:{reqDTO:{name, notInTypes, page_no, page_size}, cornerstoneParam}}
        const paramsObj = {
            Api: 'zeldaEasy.broadscope-bailian.app-control.list',
            V: '1.0',
            Data: {
                reqDTO: {
                    name: '',
                    notInTypes: [10],
                    page_no: pageNo,
                    page_size: SCAN_PAGE_SIZE
                },
                cornerstoneParam: cornerstone
            }
        };
        const form = new URLSearchParams();
        form.set('params', JSON.stringify(paramsObj));
        form.set('region', tpl.region);
        form.set('sec_token', tpl.secToken);

        const resp = await _fetch(listUrl, {
            method: tpl.method,
            credentials: 'include',
            headers: tpl.headers,
            body: form.toString()
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return JSON.parse(await resp.text());
    }

    // 扫描一个空间：完整拉取所有页，返回见到的 code 集合
    async function scanOneWorkspace(tenantId, onProgress) {
        const seen = new Set();
        let pageNo = 1;
        let total = 0;
        while (true) {
            const payload = await fetchListPageForTenant(tenantId, pageNo);
            // 直接按明确路径访问（规则 1 Fail Fast）
            const dataBlock = payload.data.DataV2.data.data;
            const list = dataBlock.list || [];
            total = dataBlock.total || total;

            // 入库（走标准 mergeList，同时清 deleted 标记）
            list.forEach(item => seen.add(item.code));
            store.mergeList(list);

            if (onProgress) onProgress({ tenantId, pageNo, pageSize: list.length, total, seen: seen.size });

            if (list.length < SCAN_PAGE_SIZE) break;
            if (seen.size >= total) break;
            pageNo++;
            if (SCAN_REQUEST_DELAY > 0) await new Promise(r => setTimeout(r, SCAN_REQUEST_DELAY));
        }
        return { seen, total };
    }

    // 全量扫描所有空间
    async function scanAllWorkspaces(onProgress) {
        if (state.scanRunning) {
            console.log(`${LOG_PREFIX} 扫描已在进行`);
            return;
        }
        if (!state.gatewayTemplate) {
            throw new Error('尚未捕获到网关模板。请先浏览一次"我的应用"列表。');
        }
        const workspaces = Object.values(store.getWorkspaces());
        if (workspaces.length === 0) {
            throw new Error('尚未捕获到空间列表。请手动切一次空间触发接口。');
        }

        state.scanRunning = true;
        state.scanProgress = {
            currentTenantId: null,
            currentWorkspaceName: null,
            currentPageNo: 0,
            currentSeen: 0,
            currentTotal: 0,
            wsIndex: 0,
            wsTotal: workspaces.length,
            totalMarkedDeleted: 0,
            totalRestored: 0
        };
        if (typeof state.onDataUpdate === 'function') state.onDataUpdate();

        try {
            for (let i = 0; i < workspaces.length; i++) {
                const ws = workspaces[i];
                state.scanProgress.wsIndex = i + 1;
                state.scanProgress.currentTenantId = ws.tenantId;
                state.scanProgress.currentWorkspaceName = ws.agentName;
                state.scanProgress.currentPageNo = 0;
                state.scanProgress.currentSeen = 0;
                state.scanProgress.currentTotal = 0;
                if (typeof state.onDataUpdate === 'function') state.onDataUpdate();

                const { seen } = await scanOneWorkspace(ws.tenantId, (p) => {
                    state.scanProgress.currentPageNo = p.pageNo;
                    state.scanProgress.currentSeen = p.seen;
                    state.scanProgress.currentTotal = p.total;
                    if (onProgress) onProgress(state.scanProgress);
                    if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
                });

                // 该空间扫描完成，diff 出已删除
                const result = store.applyScanResult(ws.tenantId, seen);
                state.scanProgress.totalMarkedDeleted += result.markedDeleted;
                state.scanProgress.totalRestored += result.restored;
                console.log(`${LOG_PREFIX} 空间 ${ws.agentName}(${ws.tenantId}) 扫描完成：见到 ${seen.size} 条，新标记删除 ${result.markedDeleted}，恢复 ${result.restored}`);

                // 扫完立刻补齐该空间的工作流详情（此时 gatewayTemplate.currentTenantId 也已经被这次扫描请求改过）
                // 注意：由于我们没走 window.fetch，模板的 currentTenantId 不会自动同步，手动同步一下让 fetchAllMissingDetails 能正确过滤
                state.gatewayTemplate.currentTenantId = String(ws.tenantId);
                if (state.gatewayTemplate.cornerstoneParam) {
                    state.gatewayTemplate.cornerstoneParam.switchAgent = Number(ws.tenantId);
                }
                await fetchAllMissingDetails();

                if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
                if (SCAN_REQUEST_DELAY > 0) await new Promise(r => setTimeout(r, SCAN_REQUEST_DELAY));
            }
        } finally {
            state.scanRunning = false;
            if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
        }
        return {
            wsScanned: state.scanProgress.wsTotal,
            markedDeleted: state.scanProgress.totalMarkedDeleted,
            restored: state.scanProgress.totalRestored
        };
    }

    // ============================================================
    // 工具
    // ============================================================
    function fmtDate(ts) {
        if (!ts) return '-';
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function typeLabel(item) {
        const t = item.type;
        const st = item.sub_type;
        if (t === 5) return st === 'react_agent' ? '智能体 (React)' : '智能体';
        if (t === 7) return st === 'chat' ? '工作流 (Chat)' : '工作流';
        return `type=${t}${st ? '/' + st : ''}`;
    }

    // 构造百炼控制台的详情页 URL
    // type=5 → assistant/{code}; type=7 → app-work-flow/{code}
    // 不同 app 属于不同空间，必须带对应 switchAgent（=tenantId）
    function buildDetailPageUrl(app) {
        if (!app.code) return null;
        const base = 'https://bailian.console.aliyun.com/cn-beijing';
        const query = new URLSearchParams({
            tab: 'app',
            productCode: 'p_efm'
        });
        if (app.tenantId != null) query.set('switchAgent', String(app.tenantId));
        let hashPath;
        if (app.type === 5) hashPath = 'assistant/' + app.code;
        else if (app.type === 7) hashPath = 'app-work-flow/' + app.code;
        else return null;
        return `${base}?${query.toString()}#/app-center/${hashPath}`;
    }

    // 返回该 app 涉及的所有模型 [{role, model, extra}]
    function collectModels(item) {
        const list = [];
        const c = item.config;
        if (c.model) list.push({ role: '主模型', model: c.model });
        if (c.web_search && c.web_search.enabled && c.web_search.model) {
            list.push({ role: '联网搜索', model: c.web_search.model });
        }
        if (c.web_search_scene && (!c.web_search || c.web_search.model !== c.web_search_scene)) {
            list.push({ role: '联网搜索(场景)', model: c.web_search_scene });
        }
        if (Array.isArray(c.rerank_models)) {
            c.rerank_models.forEach(m => list.push({ role: 'Rerank', model: m }));
        }
        // 工作流内部 LLM 节点
        if (Array.isArray(item.flow_models)) {
            // 同一模型合并计数
            const counter = {};
            item.flow_models.forEach(fm => {
                const key = fm.modelId || fm.modelName;
                counter[key] = counter[key] || { model: key, nodes: [] };
                counter[key].nodes.push(fm.nodeName);
            });
            Object.values(counter).forEach(entry => {
                list.push({
                    role: `工作流·${entry.nodes.length}节点`,
                    model: entry.model,
                    nodes: entry.nodes
                });
            });
        }
        return list;
    }

    function downloadCSV(rows, filename) {
        const csv = rows.map(row => row.map(cell => {
            const s = cell == null ? '' : String(cell);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = ce('a', { href: url, download: filename });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // ============================================================
    // UI (规则 4：纯 DOM)
    // ============================================================
    function injectStyles() {
        GM_addStyle(`
            #bl-stats-fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483600; background: #1677ff; color: #fff; border-radius: 24px; padding: 10px 14px; box-shadow: 0 4px 14px rgba(0,0,0,.2); font-size: 13px; user-select: none; display: flex; gap: 8px; align-items: center; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
            #bl-stats-fab .bl-btn { background: rgba(255,255,255,.15); padding: 4px 10px; border-radius: 12px; cursor: pointer; }
            #bl-stats-fab .bl-btn:hover { background: rgba(255,255,255,.3); }
            #bl-stats-fab .bl-count { font-weight: 600; }
            #bl-stats-fab .bl-drag { cursor: move; opacity: .6; padding: 0 4px; }
            #bl-stats-fab .bl-dot { width: 8px; height: 8px; border-radius: 50%; background: #999; display: inline-block; transition: background .3s, box-shadow .3s; }
            #bl-stats-fab .bl-dot.active { background: #52c41a; box-shadow: 0 0 6px rgba(82, 196, 26, .8); }
            #bl-stats-fab .bl-dot.flash { animation: bl-flash .5s ease-out; }
            #bl-stats-fab .bl-detail-dot { width: 6px; height: 6px; border-radius: 50%; background: #666; display: inline-block; }
            #bl-stats-fab .bl-detail-dot.ready { background: #faad14; box-shadow: 0 0 4px rgba(250, 173, 20, .8); }
            #bl-stats-fab .bl-detail-dot.running { background: #1677ff; box-shadow: 0 0 4px rgba(22, 119, 255, .8); animation: bl-pulse 1s ease-in-out infinite; }
            @keyframes bl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
            @keyframes bl-flash { 0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(82, 196, 26, .9); } 60% { transform: scale(1.4); box-shadow: 0 0 0 8px rgba(82, 196, 26, 0); } 100% { transform: scale(1); box-shadow: 0 0 6px rgba(82, 196, 26, .8); } }
            #bl-stats-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 2147483610; display: flex; align-items: center; justify-content: center; }
            #bl-stats-modal { width: min(1200px, 96vw); height: min(760px, 92vh); background: #fff; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; font-size: 13px; color: #1f1f1f; }
            #bl-stats-modal header { padding: 14px 18px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 12px; }
            #bl-stats-modal header h3 { margin: 0; font-size: 15px; font-weight: 600; }
            #bl-stats-modal header .spacer { flex: 1; }
            #bl-stats-modal header .icon-btn { cursor: pointer; padding: 4px 10px; border-radius: 6px; background: #f5f5f5; border: 1px solid #e0e0e0; font-size: 12px; }
            #bl-stats-modal header .icon-btn:hover { background: #eaeaea; }
            #bl-stats-modal header .icon-btn.primary { background: #1677ff; color: #fff; border-color: #1677ff; }
            #bl-stats-modal header .icon-btn.primary:hover { background: #0958d9; }
            #bl-stats-modal header .icon-btn.disabled { opacity: .5; pointer-events: none; }
            #bl-stats-modal .body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
            #bl-stats-modal .stats-bar { padding: 10px 18px; border-bottom: 1px solid #f0f0f0; background: #fafafa; display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
            #bl-stats-modal .stats-bar .stat { display: flex; gap: 6px; align-items: baseline; }
            #bl-stats-modal .stats-bar .stat-label { color: #666; }
            #bl-stats-modal .stats-bar .stat-value { font-weight: 600; color: #1677ff; }
            #bl-stats-modal .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 18px; border-bottom: 1px solid #f0f0f0; max-height: 120px; overflow: auto; }
            #bl-stats-modal .chip { padding: 2px 10px; background: #f0f5ff; color: #1677ff; border: 1px solid #d6e4ff; border-radius: 12px; cursor: pointer; font-size: 12px; }
            #bl-stats-modal .chip .cnt { color: #666; margin-left: 4px; }
            #bl-stats-modal .chip.active { background: #1677ff; color: #fff; border-color: #1677ff; }
            #bl-stats-modal .chip.active .cnt { color: rgba(255,255,255,.85); }
            #bl-stats-modal .filters { padding: 10px 18px; border-bottom: 1px solid #f0f0f0; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
            #bl-stats-modal .filters input, #bl-stats-modal .filters select { border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 8px; font-size: 12px; }
            #bl-stats-modal .filters input[type=text] { min-width: 200px; }
            #bl-stats-modal .table-wrap { flex: 1; overflow: auto; }
            #bl-stats-modal table { width: 100%; border-collapse: collapse; }
            #bl-stats-modal thead th { position: sticky; top: 0; background: #fafafa; padding: 8px 10px; font-size: 12px; font-weight: 600; border-bottom: 1px solid #eee; text-align: left; color: #555; z-index: 1; white-space: nowrap; }
            #bl-stats-modal tbody td { padding: 8px 10px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
            #bl-stats-modal tbody tr:hover { background: #fafcff; }
            #bl-stats-modal tbody a:hover { text-decoration: underline !important; }
            #bl-stats-modal .model-tag { display: inline-block; padding: 1px 8px; background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; border-radius: 10px; font-size: 11px; margin: 1px 4px 1px 0; }
            #bl-stats-modal .model-tag.role-联网搜索, #bl-stats-modal .model-tag.role-联网搜索场景 { background: #fff7e6; color: #d46b08; border-color: #ffd591; }
            #bl-stats-modal .model-tag.role-Rerank { background: #f9f0ff; color: #722ed1; border-color: #d3adf7; }
            #bl-stats-modal .model-tag.role-flow { background: #e6fffb; color: #08979c; border-color: #87e8de; }
            #bl-stats-modal .model-tag.empty { background: #fff1f0; color: #cf1322; border-color: #ffa39e; }
            #bl-stats-modal .model-tag.pending { background: #fafafa; color: #999; border-color: #e0e0e0; }
            #bl-stats-modal .depr-badge { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 8px; font-size: 10px; font-weight: 600; vertical-align: middle; line-height: 14px; }
            #bl-stats-modal .depr-badge.notice { background: #fffbe6; color: #ad6800; border: 1px solid #ffe58f; }
            #bl-stats-modal .depr-badge.warning { background: #fff7e6; color: #d46b08; border: 1px solid #ffd591; }
            #bl-stats-modal .depr-badge.critical { background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; animation: bl-blink 1.2s ease-in-out infinite; }
            #bl-stats-modal .depr-badge.offline { background: #520a08; color: #fff; border: 1px solid #520a08; animation: bl-blink 1.2s ease-in-out infinite; }
            #bl-stats-modal .depr-badge.future { background: #f5f5f5; color: #666; border: 1px solid #e0e0e0; }
            @keyframes bl-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
            #bl-stats-modal tr.risk-notice { background: #fffbe6; }
            #bl-stats-modal tr.risk-warning { background: #fff7e6; }
            #bl-stats-modal tr.risk-critical { background: #fff1f0; }
            #bl-stats-modal tr.risk-offline { background: #ffccc7; }
            #bl-stats-modal tr.risk-notice:hover { background: #fff5c2; }
            #bl-stats-modal tr.risk-warning:hover { background: #ffe7ba; }
            #bl-stats-modal tr.risk-critical:hover { background: #ffa39e; }
            #bl-stats-modal tr.risk-offline:hover { background: #ff7875; }
            #bl-stats-modal td.risk-cell { font-weight: 600; font-size: 11px; white-space: nowrap; }
            #bl-stats-modal td.risk-cell.notice { color: #ad6800; }
            #bl-stats-modal td.risk-cell.warning { color: #d46b08; }
            #bl-stats-modal td.risk-cell.critical { color: #cf1322; }
            #bl-stats-modal td.risk-cell.offline { color: #520a08; }
            #bl-stats-modal tr.is-deleted { opacity: 0.55; }
            #bl-stats-modal tr.is-deleted:hover { opacity: 0.85; }
            #bl-stats-modal tr.is-deleted td { text-decoration: line-through; }
            #bl-stats-modal .deleted-badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10px; font-weight: 600; background: #f5f5f5; color: #666; border: 1px solid #d9d9d9; }
            #bl-stats-modal .type-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
            #bl-stats-modal .type-badge.agent { background: #e6f4ff; color: #1677ff; }
            #bl-stats-modal .type-badge.workflow { background: #f9f0ff; color: #722ed1; }
            #bl-stats-modal footer { padding: 10px 18px; border-top: 1px solid #f0f0f0; display: flex; gap: 10px; align-items: center; background: #fafafa; }
            #bl-stats-modal footer .msg { color: #666; font-size: 12px; }
            #bl-stats-modal footer .spacer { flex: 1; }
            #bl-stats-modal button.primary { background: #1677ff; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
            #bl-stats-modal button.primary:hover { background: #0958d9; }
            #bl-stats-modal button.primary:disabled { opacity: .5; cursor: not-allowed; }
            #bl-stats-modal button.ghost { background: #fff; color: #1f1f1f; border: 1px solid #d9d9d9; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
            #bl-stats-modal button.ghost:hover { border-color: #1677ff; color: #1677ff; }
            #bl-stats-modal button.danger { background: #fff; color: #ff4d4f; border: 1px solid #ffa39e; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
            #bl-stats-modal button.danger:hover { background: #fff1f0; }
        `);
    }

    function createFab() {
        const fab = ce('div', { id: 'bl-stats-fab' }, [
            ce('span', { className: 'bl-drag', title: '拖拽', textContent: '≡' }),
            ce('span', { className: 'bl-dot', id: 'bl-fab-dot', title: '列表监听' }),
            ce('span', { className: 'bl-detail-dot', id: 'bl-fab-detail-dot', title: '详情模板' }),
            ce('span', { textContent: '百炼模型' }),
            ce('span', { className: 'bl-count', id: 'bl-fab-countwrap' }, [
                '(',
                ce('span', { id: 'bl-fab-count', textContent: '0' }),
                ce('span', { id: 'bl-fab-total' }),
                ')'
            ]),
            ce('span', { className: 'bl-btn', id: 'bl-fab-view', textContent: '查看' })
        ]);
        document.body.appendChild(fab);

        const countEl = document.getElementById('bl-fab-count');
        const totalEl = document.getElementById('bl-fab-total');
        const dotEl = document.getElementById('bl-fab-dot');
        const detailDotEl = document.getElementById('bl-fab-detail-dot');
        const countWrap = document.getElementById('bl-fab-countwrap');

        function refreshCount() {
            const stored = Object.keys(store.getApps()).length;
            countEl.textContent = String(state.sessionAdded);
            totalEl.textContent = ` / ${stored}`;
            countWrap.title = `本次会话新增 ${state.sessionAdded}\n本地已存总数 ${stored}${state.latestTotal ? '\n接口 total ' + state.latestTotal : ''}`;

            // 列表拦截灯
            dotEl.classList.toggle('active', state.lastCaptureAt > 0);
            if (state.lastCaptureAt > 0) {
                dotEl.title = `列表拦截：${fmtDate(state.lastCaptureAt)}${state.latestPageNo ? ' 第' + state.latestPageNo + '页' : ''}`;
                dotEl.classList.add('flash');
                setTimeout(() => dotEl.classList.remove('flash'), 600);
            } else {
                dotEl.title = '尚未拦截到列表接口';
            }

            // 详情灯
            detailDotEl.classList.remove('ready', 'running');
            if (state.detailRunning) {
                detailDotEl.classList.add('running');
                const p = state.detailProgress;
                detailDotEl.title = `工作流详情抓取中 ${p.done}/${p.total}${p.failed ? '（失败' + p.failed + '）' : ''}`;
            } else if (state.gatewayTemplate) {
                detailDotEl.classList.add('ready');
                detailDotEl.title = `网关模板就绪（${fmtDate(state.gatewayTemplate.capturedAt)}），可自动派生详情请求`;
            } else {
                detailDotEl.title = '尚未捕获网关模板，请浏览一次"我的应用"列表';
            }
        }

        refreshCount();
        state.onDataUpdate = refreshCount;

        document.getElementById('bl-fab-view').addEventListener('click', openModal);

        // 拖拽
        const drag = fab.querySelector('.bl-drag');
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        drag.addEventListener('mousedown', e => {
            dragging = true; sx = e.clientX; sy = e.clientY;
            const rect = fab.getBoundingClientRect();
            ox = rect.left; oy = rect.top;
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!dragging) return;
            fab.style.left = (ox + (e.clientX - sx)) + 'px';
            fab.style.top = (oy + (e.clientY - sy)) + 'px';
            fab.style.right = 'auto';
            fab.style.bottom = 'auto';
        });
        window.addEventListener('mouseup', () => { dragging = false; });
    }

    function openModal() {
        const exist = document.getElementById('bl-stats-modal-mask');
        if (exist) exist.remove();

        const filters = { q: '', type: '', sub: '', hasModel: '', modelChip: '', tenantId: '', risk: '', deleted: 'exclude' };
        // 首次读取缓存，之后 fetchDeprecationDoc 触发刷新时会重新渲染
        let deprecationCache = getDeprecationCache();

        // Header
        const scanBtn = ce('span', { className: 'icon-btn primary', id: 'bl-scan-all', textContent: '全量扫描' });
        const fetchBtn = ce('span', { className: 'icon-btn', id: 'bl-fetch-detail', textContent: '补齐工作流详情' });
        const deprBtn = ce('span', { className: 'icon-btn', id: 'bl-fetch-depr', textContent: '刷新下架数据' });
        const header = ce('header', {}, [
            ce('h3', { textContent: '百炼智能体 / 工作流模型统计' }),
            ce('span', { className: 'spacer' }),
            scanBtn,
            fetchBtn,
            deprBtn,
            ce('span', { className: 'icon-btn', id: 'bl-refresh', textContent: '刷新' }),
            ce('span', { className: 'icon-btn', id: 'bl-export', textContent: '导出 CSV' }),
            ce('span', { className: 'icon-btn', id: 'bl-close', textContent: '关闭' })
        ]);

        // Body
        const statsBar = ce('div', { className: 'stats-bar', id: 'bl-stats-bar' });
        const chipsBar = ce('div', { className: 'chips', id: 'bl-model-chips' });

        const workspaceSelect = ce('select', { id: 'bl-filter-workspace' }, [
            ce('option', { value: '', textContent: '全部空间' })
        ]);
        const typeSelect = ce('select', { id: 'bl-filter-type' }, [
            ce('option', { value: '', textContent: '全部类型' }),
            ce('option', { value: '5', textContent: '智能体 (type=5)' }),
            ce('option', { value: '7', textContent: '工作流 (type=7)' })
        ]);
        const subSelect = ce('select', { id: 'bl-filter-subtype' }, [
            ce('option', { value: '', textContent: '全部子类型' })
        ]);
        const hasModelSelect = ce('select', { id: 'bl-filter-hasmodel' }, [
            ce('option', { value: '', textContent: '模型：全部' }),
            ce('option', { value: 'yes', textContent: '已有模型' }),
            ce('option', { value: 'no', textContent: '完全无模型' }),
            ce('option', { value: 'pending', textContent: '工作流待补齐' })
        ]);
        const deletedSelect = ce('select', { id: 'bl-filter-deleted' }, [
            ce('option', { value: 'exclude', textContent: '在架应用（默认）' }),
            ce('option', { value: 'all', textContent: '含已删除' }),
            ce('option', { value: 'only', textContent: '仅看已删除' })
        ]);
        const riskSelect = ce('select', { id: 'bl-filter-risk' }, [
            ce('option', { value: '', textContent: '下架风险：全部' }),
            ce('option', { value: 'offline', textContent: '已下线' }),
            ce('option', { value: 'critical', textContent: '≤7 日下架' }),
            ce('option', { value: 'warning', textContent: '≤15 日下架' }),
            ce('option', { value: 'notice', textContent: '≤30 日下架' })
        ]);

        const filtersBar = ce('div', { className: 'filters' }, [
            ce('input', { type: 'text', id: 'bl-search', placeholder: '按名称 / code / 描述 / 节点名搜索...' }),
            workspaceSelect, typeSelect, subSelect, hasModelSelect, riskSelect, deletedSelect,
            ce('span', { style: { color: '#999', fontSize: '12px' } }, [
                '共 ', ce('span', { id: 'bl-filter-count', textContent: '0' }), ' 条'
            ])
        ]);

        const tbody = ce('tbody', { id: 'bl-tbody' });
        const tableWrap = ce('div', { className: 'table-wrap' }, [
            ce('table', {}, [
                ce('thead', {}, [
                    ce('tr', {}, [
                        ce('th', { style: { width: '50px' }, textContent: '#' }),
                        ce('th', { style: { width: '220px' }, textContent: '名称' }),
                        ce('th', { style: { width: '130px' }, textContent: '空间' }),
                        ce('th', { style: { width: '130px' }, textContent: '类型' }),
                        ce('th', { textContent: '模型' }),
                        ce('th', { style: { width: '110px' }, textContent: '下架风险' }),
                        ce('th', { style: { width: '130px' }, textContent: '最后修改' }),
                        ce('th', { style: { width: '90px' }, textContent: '状态' })
                    ])
                ]),
                tbody
            ])
        ]);

        const body = ce('div', { className: 'body' }, [statsBar, chipsBar, filtersBar, tableWrap]);

        // Footer
        const footer = ce('footer', {}, [
            ce('span', { className: 'msg', id: 'bl-footer-msg' }),
            ce('span', { className: 'spacer' }),
            ce('button', { className: 'ghost', id: 'bl-purge-deleted', textContent: '清理已删除' }),
            ce('button', { className: 'danger', id: 'bl-clear', textContent: '清空数据' })
        ]);

        const modal = ce('div', { id: 'bl-stats-modal', onClick: e => e.stopPropagation() }, [header, body, footer]);
        const mask = ce('div', { id: 'bl-stats-modal-mask', onClick: () => mask.remove() }, [modal]);
        document.body.appendChild(mask);

        function render() {
            const apps = Object.values(store.getApps());
            const workspaces = store.getWorkspaces();

            // 空间下拉：合并"接口拿到的" + "app 上出现过的 tenantId"
            const tenantIdSet = new Set(Object.keys(workspaces));
            apps.forEach(a => { if (a.tenantId != null) tenantIdSet.add(String(a.tenantId)); });
            const tenantOptions = Array.from(tenantIdSet).sort((a, b) => {
                // 有名字的排前
                const na = workspaces[a] && workspaces[a].agentName;
                const nb = workspaces[b] && workspaces[b].agentName;
                if (na && !nb) return -1;
                if (!na && nb) return 1;
                return (na || a).localeCompare(nb || b);
            });
            const curWs = workspaceSelect.value;
            workspaceSelect.textContent = '';
            workspaceSelect.appendChild(ce('option', { value: '', textContent: '全部空间' }));
            tenantOptions.forEach(tid => {
                const ws = workspaces[tid];
                const label = ws ? `${ws.agentName}${ws.defaultAgent ? ' (默认)' : ''}` : `空间 ${tid}`;
                workspaceSelect.appendChild(ce('option', { value: tid, textContent: label }));
            });
            workspaceSelect.value = curWs;

            // 子类型
            const subTypes = Array.from(new Set(apps.map(a => a.sub_type).filter(Boolean))).sort();
            const curSub = subSelect.value;
            subSelect.textContent = '';
            subSelect.appendChild(ce('option', { value: '', textContent: '全部子类型' }));
            subTypes.forEach(s => subSelect.appendChild(ce('option', { value: s, textContent: s })));
            subSelect.value = curSub;

            // 统计（受空间过滤影响）
            const inScope = filters.tenantId ? apps.filter(a => String(a.tenantId) === filters.tenantId) : apps;
            const totalStored = inScope.length;
            const agentCount = inScope.filter(a => a.type === 5).length;
            const workflowCount = inScope.filter(a => a.type === 7).length;
            const flowFilled = inScope.filter(a => a.type === 7 && a.flow_models).length;
            const flowPending = workflowCount - flowFilled;
            const workspaceCount = new Set(inScope.map(a => String(a.tenantId)).filter(Boolean)).size;

            const modelCounter = {};
            inScope.forEach(a => {
                const models = collectModels(a);
                if (models.length === 0) {
                    modelCounter['(未配置)'] = modelCounter['(未配置)'] || { total: 0, agent: 0, workflow: 0 };
                    modelCounter['(未配置)'].total++;
                    if (a.type === 5) modelCounter['(未配置)'].agent++;
                    if (a.type === 7) modelCounter['(未配置)'].workflow++;
                }
                const seen = new Set();
                models.forEach(m => {
                    if (seen.has(m.model)) return;
                    seen.add(m.model);
                    modelCounter[m.model] = modelCounter[m.model] || { total: 0, agent: 0, workflow: 0 };
                    modelCounter[m.model].total++;
                    if (a.type === 5) modelCounter[m.model].agent++;
                    if (a.type === 7) modelCounter[m.model].workflow++;
                });
            });

            statsBar.textContent = '';
            const statItems = [
                ['总数：', totalStored],
                ['空间：', workspaceCount || '-'],
                ['智能体：', agentCount],
                ['工作流：', `${workflowCount}${flowPending > 0 ? ` (${flowPending}待补齐)` : ''}`],
                ['不同模型：', Object.keys(modelCounter).length],
                ['接口 total：', state.latestTotal || '-']
            ];
            statItems.forEach(([label, val]) => {
                statsBar.appendChild(ce('div', { className: 'stat' }, [
                    ce('span', { className: 'stat-label', textContent: label }),
                    ce('span', { className: 'stat-value', textContent: val })
                ]));
            });

            chipsBar.textContent = '';
            Object.entries(modelCounter).sort((a, b) => b[1].total - a[1].total).forEach(([m, info]) => {
                const chipChildren = [
                    m,
                    ce('span', { className: 'cnt', textContent: info.total })
                ];
                // 顶部模型筛选处的下架天数标注
                const deprInfo = getDeprecationInfoForModel(m, deprecationCache);
                let chipTitle = `智能体:${info.agent} / 工作流:${info.workflow}`;
                if (deprInfo) {
                    const label = deprInfo.level === 'offline'
                        ? `已下线${-deprInfo.daysLeft}天`
                        : `[${deprInfo.daysLeft}]`;
                    chipChildren.push(ce('span', {
                        className: `depr-badge ${deprInfo.level}`,
                        textContent: label
                    }));
                    const dateStr = fmtDate(deprInfo.offlineAt).slice(0, 10);
                    chipTitle += deprInfo.level === 'offline'
                        ? `\n⚠️ 已于 ${dateStr} 下线（${-deprInfo.daysLeft} 天前）\n替代：${deprInfo.alternative}`
                        : `\n${dateStr} 下架（剩 ${deprInfo.daysLeft} 天）\n替代：${deprInfo.alternative}`;
                }
                const chip = ce('span', {
                    className: `chip ${filters.modelChip === m ? 'active' : ''}`,
                    title: chipTitle
                }, chipChildren);
                chip.addEventListener('click', () => {
                    filters.modelChip = (filters.modelChip === m) ? '' : m;
                    render();
                });
                chipsBar.appendChild(chip);
            });

            // 过滤
            const q = filters.q.trim().toLowerCase();
            const riskRank = { offline: 4, critical: 3, warning: 2, notice: 1 };
            const filtered = apps.filter(a => {
                // 删除态过滤
                if (filters.deleted === 'exclude' && a.deleted) return false;
                if (filters.deleted === 'only' && !a.deleted) return false;

                if (filters.tenantId && String(a.tenantId) !== filters.tenantId) return false;
                if (filters.type && String(a.type) !== filters.type) return false;
                if (filters.sub && a.sub_type !== filters.sub) return false;

                if (filters.hasModel === 'yes' && collectModels(a).length === 0) return false;
                if (filters.hasModel === 'no' && collectModels(a).length > 0) return false;
                if (filters.hasModel === 'pending' && !(a.type === 7 && !a.flow_models)) return false;

                if (filters.modelChip) {
                    const models = collectModels(a);
                    if (filters.modelChip === '(未配置)' && models.length > 0) return false;
                    if (filters.modelChip !== '(未配置)' && !models.some(m => m.model === filters.modelChip)) return false;
                }
                if (filters.risk) {
                    const risk = getMostUrgentDeprecation(a, deprecationCache);
                    if (!risk) return false;
                    if (filters.risk === 'offline') {
                        // "已下线" 只显示 offline
                        if (risk.level !== 'offline') return false;
                    } else {
                        // notice / warning / critical: 展示"该级别及以上"（含 offline）
                        const need = riskRank[filters.risk];
                        if (!need || riskRank[risk.level] < need) return false;
                    }
                }
                if (q) {
                    const nodeNames = Array.isArray(a.flow_models) ? a.flow_models.map(x => x.nodeName).join(' ') : '';
                    const hay = [a.name, a.code, a.description, a.sub_type, nodeNames].filter(Boolean).join(' ').toLowerCase();
                    if (hay.indexOf(q) === -1) return false;
                }
                return true;
            }).sort((a, b) => {
                const ra = getMostUrgentDeprecation(a, deprecationCache);
                const rb = getMostUrgentDeprecation(b, deprecationCache);
                const rva = ra ? riskRank[ra.level] || 0 : 0;
                const rvb = rb ? riskRank[rb.level] || 0 : 0;
                if (rva !== rvb) return rvb - rva;
                return (b.gmt_modified || 0) - (a.gmt_modified || 0);
            });

            document.getElementById('bl-filter-count').textContent = filtered.length;

            tbody.textContent = '';
            if (filtered.length === 0) {
                tbody.appendChild(ce('tr', {}, [
                    ce('td', { colSpan: 8, style: { textAlign: 'center', padding: '40px', color: '#999' }, textContent: '暂无数据' })
                ]));
            } else {
                filtered.forEach((a, i) => {
                    const models = collectModels(a);
                    const isPendingFlow = a.type === 7 && !a.flow_models;
                    let modelTags;
                    if (models.length === 0) {
                        modelTags = isPendingFlow
                            ? [ce('span', { className: 'model-tag pending', textContent: '工作流·待补齐详情' })]
                            : [ce('span', { className: 'model-tag empty', textContent: '未配置' })];
                    } else {
                        modelTags = models.map(m => {
                            const isFlow = typeof m.role === 'string' && m.role.startsWith('工作流');
                            const cls = 'model-tag ' + (isFlow ? 'role-flow' : ('role-' + m.role.replace(/[()]/g, '')));
                            const title = m.nodes ? `${m.role}: ${m.nodes.join(', ')}` : m.role;
                            const children = [
                                m.model,
                                ce('span', { style: { opacity: '0.6', marginLeft: '4px' }, textContent: `·${m.role}` })
                            ];
                            // 单模型的下架标记
                            const info = getDeprecationInfoForModel(m.model, deprecationCache);
                            if (info) {
                                const label = info.level === 'offline'
                                    ? `已下线${-info.daysLeft}天`
                                    : `[${info.daysLeft}]`;
                                const dateStr = fmtDate(info.offlineAt).slice(0, 10);
                                const badgeTitle = info.level === 'offline'
                                    ? `⚠️ 已于 ${dateStr} 下线\n替代：${info.alternative}`
                                    : `将于 ${dateStr} 下架，剩 ${info.daysLeft} 天\n替代：${info.alternative}`;
                                children.push(ce('span', {
                                    className: `depr-badge ${info.level}`,
                                    title: badgeTitle,
                                    textContent: label
                                }));
                            }
                            return ce('span', { className: cls, title }, children);
                        });
                        if (isPendingFlow) {
                            modelTags.push(ce('span', { className: 'model-tag pending', textContent: '待补齐' }));
                        }
                    }

                    const badgeCls = a.type === 5 ? 'agent' : (a.type === 7 ? 'workflow' : '');
                    const statusMap = { 1: '已发布', 3: '草稿', 4: '已发布', 5: '已下线' };
                    const ws = a.tenantId != null ? workspaces[String(a.tenantId)] : null;
                    const wsLabel = ws ? ws.agentName : (a.tenantId ? `空间 ${a.tenantId}` : '-');
                    const risk = getMostUrgentDeprecation(a, deprecationCache);

                    // 风险单元格
                    let riskCell;
                    if (risk) {
                        const levelText = {
                            offline: '⚫ 已下线',
                            critical: '🔴 紧急',
                            warning: '🟠 警告',
                            notice: '🟡 关注'
                        }[risk.level];
                        const dateStr = fmtDate(risk.offlineAt).slice(0, 10);
                        const daysStr = risk.level === 'offline'
                            ? `已下线 ${-risk.daysLeft} 天`
                            : `剩 ${risk.daysLeft} 天`;
                        const cellTitle = risk.level === 'offline'
                            ? `${risk.modelId} 已于 ${dateStr} 下线\n替代：${risk.alternative}`
                            : `${risk.modelId} 将于 ${dateStr} 下架\n替代：${risk.alternative}`;
                        riskCell = ce('td', {
                            className: `risk-cell ${risk.level}`,
                            title: cellTitle
                        }, [
                            ce('div', { textContent: levelText }),
                            ce('div', { style: { fontWeight: 'normal', color: '#666', fontSize: '11px' }, textContent: daysStr })
                        ]);
                    } else {
                        riskCell = ce('td', { style: { color: '#ccc', fontSize: '11px' }, textContent: '-' });
                    }

                    const detailUrl = buildDetailPageUrl(a);
                    const nameChildren = [];
                    if (detailUrl && !a.deleted) {
                        nameChildren.push(ce('a', {
                            href: detailUrl,
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            style: { fontWeight: '500', color: '#1677ff', textDecoration: 'none' },
                            title: '在新标签页打开详情',
                            textContent: a.name
                        }));
                    } else {
                        nameChildren.push(ce('span', { style: { fontWeight: '500' }, textContent: a.name }));
                    }
                    if (a.deleted) {
                        nameChildren.push(ce('span', {
                            className: 'deleted-badge',
                            title: a.deletedAt ? '标记于 ' + fmtDate(a.deletedAt) : '',
                            textContent: '已删除'
                        }));
                    }
                    const nameNode = ce('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, nameChildren);

                    // 合并 risk 和 deleted class
                    const trClasses = [];
                    if (risk) trClasses.push('risk-' + risk.level);
                    if (a.deleted) trClasses.push('is-deleted');
                    const trAttrs2 = trClasses.length ? { className: trClasses.join(' ') } : {};

                    const tr = ce('tr', trAttrs2, [
                        ce('td', { textContent: i + 1 }),
                        ce('td', {}, [
                            nameNode,
                            ce('div', { style: { color: '#999', fontSize: '11px', marginTop: '2px' }, title: a.code, textContent: `${a.code.slice(0, 12)}...` }),
                            a.description ? ce('div', { style: { color: '#888', fontSize: '11px', marginTop: '2px' }, textContent: a.description.slice(0, 60) }) : ''
                        ]),
                        ce('td', {
                            style: { color: '#666', fontSize: '12px' },
                            title: a.tenantId != null ? `tenantId: ${a.tenantId}` : ''
                        }, [wsLabel]),
                        ce('td', {}, [ce('span', { className: `type-badge ${badgeCls}`, textContent: typeLabel(a) })]),
                        ce('td', {}, modelTags),
                        riskCell,
                        ce('td', { style: { color: '#666' }, textContent: fmtDate(a.gmt_modified) }),
                        ce('td', {}, [ce('span', { style: { color: '#666' }, textContent: statusMap[a.status] || a.status || '-' })])
                    ]);
                    tbody.appendChild(tr);
                });
            }

            // Footer 状态
            const parts = [];
            if (state.gatewayTemplate && state.gatewayTemplate.currentTenantId) {
                const tid = state.gatewayTemplate.currentTenantId;
                const ws = workspaces[tid];
                parts.push(`当前空间：${ws ? ws.agentName : tid}`);
            }
            if (state.lastCaptureAt > 0) {
                parts.push(`列表：${fmtDate(state.lastCaptureAt)}${state.latestPageNo ? '（第' + state.latestPageNo + '页）' : ''}`);
            } else {
                parts.push('列表：未拦截');
            }
            if (state.scanRunning && state.scanProgress) {
                const p = state.scanProgress;
                const wsPart = p.currentWorkspaceName ? `${p.currentWorkspaceName}` : '';
                const pagePart = p.currentTotal ? `第${p.currentPageNo}页 ${p.currentSeen}/${p.currentTotal}` : `第${p.currentPageNo}页`;
                parts.push(`扫描中 [${p.wsIndex}/${p.wsTotal}] ${wsPart} · ${pagePart}`);
            } else if (state.detailRunning) {
                const p = state.detailProgress;
                parts.push(`详情抓取中 ${p.done}/${p.total}${p.failed ? '（失败' + p.failed + '）' : ''}`);
            } else if (state.gatewayTemplate) {
                parts.push(`网关模板：已就绪`);
            } else {
                parts.push('网关模板：未捕获（请浏览一次列表页）');
            }
            const delCount = apps.filter(a => a.deleted).length;
            if (delCount > 0) parts.push(`已标记删除 ${delCount} 条`);
            document.getElementById('bl-footer-msg').textContent = parts.join(' · ');

            // 扫描按钮状态
            if (state.scanRunning && state.scanProgress) {
                const p = state.scanProgress;
                scanBtn.textContent = `扫描中 ${p.wsIndex}/${p.wsTotal}`;
                scanBtn.classList.add('disabled');
            } else if (!state.gatewayTemplate) {
                scanBtn.textContent = '全量扫描 (无模板)';
                scanBtn.classList.add('disabled');
            } else if (Object.keys(store.getWorkspaces()).length === 0) {
                scanBtn.textContent = '全量扫描 (无空间数据)';
                scanBtn.classList.add('disabled');
            } else {
                scanBtn.textContent = `全量扫描 (${Object.keys(store.getWorkspaces()).length}个空间)`;
                scanBtn.classList.remove('disabled');
            }

            // 补齐按钮状态
            const flowMissing = apps.filter(a => a.type === 7 && !a.flow_models && !a.deleted).length;
            if (state.detailRunning) {
                const p = state.detailProgress;
                fetchBtn.textContent = `抓取中 ${p.done}/${p.total}`;
                fetchBtn.classList.add('disabled');
            } else if (!state.gatewayTemplate) {
                fetchBtn.textContent = '补齐工作流详情 (无模板)';
                fetchBtn.classList.add('disabled');
            } else if (flowMissing === 0) {
                fetchBtn.textContent = '工作流详情已齐';
                fetchBtn.classList.add('disabled');
            } else {
                fetchBtn.textContent = `补齐工作流详情 (${flowMissing})`;
                fetchBtn.classList.remove('disabled');
            }
        }

        // Events
        document.getElementById('bl-close').addEventListener('click', () => mask.remove());
        document.getElementById('bl-refresh').addEventListener('click', render);
        document.getElementById('bl-search').addEventListener('input', e => { filters.q = e.target.value; render(); });
        workspaceSelect.addEventListener('change', e => { filters.tenantId = e.target.value; render(); });
        typeSelect.addEventListener('change', e => { filters.type = e.target.value; render(); });
        subSelect.addEventListener('change', e => { filters.sub = e.target.value; render(); });
        hasModelSelect.addEventListener('change', e => { filters.hasModel = e.target.value; render(); });
        riskSelect.addEventListener('change', e => { filters.risk = e.target.value; render(); });
        deletedSelect.addEventListener('change', e => { filters.deleted = e.target.value; render(); });

        document.getElementById('bl-purge-deleted').addEventListener('click', () => {
            const apps = Object.values(store.getApps());
            const n = apps.filter(a => a.deleted).length;
            if (n === 0) { alert('当前没有已标记删除的记录'); return; }
            if (!confirm(`将永久删除 ${n} 条已标记删除的记录，不可恢复。继续？`)) return;
            const purged = store.purgeDeleted();
            alert(`已清理 ${purged} 条`);
            render();
            if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
        });

        document.getElementById('bl-clear').addEventListener('click', () => {
            if (!confirm('确认清空所有已抓取数据？此操作不可恢复。')) return;
            store.clear();
            GM_deleteValue(WORKSPACES_KEY);
            GM_deleteValue(DEPRECATION_KEY);
            deprecationCache = null;
            state.latestTotal = 0;
            state.latestPageNo = 0;
            state.lastCaptureAt = 0;
            state.sessionAdded = 0;
            render();
            if (typeof state.onDataUpdate === 'function') state.onDataUpdate();
        });

        fetchBtn.addEventListener('click', () => {
            fetchAllMissingDetails()
                .then(() => render())
                .catch(e => alert('补齐失败：' + e.message));
        });

        scanBtn.addEventListener('click', () => {
            if (state.scanRunning) return;
            if (!confirm('将遍历所有已知空间的所有列表页并识别已删除的应用。\n（同时会补齐这些空间的工作流详情）\n\n继续？')) return;
            scanAllWorkspaces(() => render())
                .then(r => {
                    if (r) alert(`扫描完成：\n空间数 ${r.wsScanned}\n新标记删除 ${r.markedDeleted} 条\n恢复 ${r.restored} 条`);
                    render();
                })
                .catch(e => alert('扫描失败：' + e.message));
        });

        deprBtn.addEventListener('click', () => {
            const old = deprBtn.textContent;
            deprBtn.textContent = '拉取中...';
            deprBtn.classList.add('disabled');
            fetchDeprecationDoc(true).then(cache => {
                deprecationCache = cache;
                render();
            }).catch(e => alert('拉取下架数据失败：' + e.message)).finally(() => {
                deprBtn.textContent = old;
                deprBtn.classList.remove('disabled');
            });
        });

        document.getElementById('bl-export').addEventListener('click', () => {
            const apps = Object.values(store.getApps()).sort((a, b) => (b.gmt_modified || 0) - (a.gmt_modified || 0));
            const workspaces = store.getWorkspaces();
            const rows = [['名称', 'code', '空间', 'tenantId', '类型', '子类型', '主模型', '联网搜索模型', 'Rerank模型', '工作流模型', '工作流节点数', '下架风险', '最近下架模型', '下架日期', '剩余天数', '替代模型', '状态', '创建时间', '修改时间', '描述']];
            apps.forEach(a => {
                const models = collectModels(a);
                const main = a.config && a.config.model ? a.config.model : '';
                const web = models.filter(m => typeof m.role === 'string' && m.role.indexOf('联网搜索') === 0).map(m => m.model).join('|');
                const rerank = models.filter(m => m.role === 'Rerank').map(m => m.model).join('|');
                const flow = Array.isArray(a.flow_models)
                    ? Array.from(new Set(a.flow_models.map(m => m.modelId || m.modelName))).join('|')
                    : (a.type === 7 ? '(待补齐)' : '');
                const flowCount = Array.isArray(a.flow_models) ? a.flow_models.length : '';
                const statusMap = { 1: '已发布', 3: '草稿', 4: '已发布', 5: '已下线' };
                const ws = a.tenantId != null ? workspaces[String(a.tenantId)] : null;
                const wsLabel = ws ? ws.agentName : '';
                const risk = getMostUrgentDeprecation(a, deprecationCache);
                // offline 也支持导出（app 用了已下线模型）
                const riskLevelMap = { offline: '已下线模型', critical: '紧急', warning: '警告', notice: '关注' };
                const riskLevel = risk ? (riskLevelMap[risk.level] || '') : '';
                const riskModel = risk ? risk.modelId : '';
                const riskDate = risk ? fmtDate(risk.offlineAt).slice(0, 10) : '';
                const riskDays = risk ? risk.daysLeft : '';
                const riskAlt = risk ? risk.alternative : '';
                // 状态列：应用被删除时直接覆盖标注
                const statusCell = a.deleted
                    ? (a.deletedAt ? `已删除（${fmtDate(a.deletedAt)}）` : '已删除')
                    : (statusMap[a.status] || a.status || '');
                rows.push([
                    a.name, a.code, wsLabel, a.tenantId || '', typeLabel(a), a.sub_type || '', main, web, rerank, flow, flowCount,
                    riskLevel, riskModel, riskDate, riskDays, riskAlt,
                    statusCell, fmtDate(a.gmt_create), fmtDate(a.gmt_modified), a.description || ''
                ]);
            });
            downloadCSV(rows, `bailian_models_${Date.now()}.csv`);
        });

        render();

        // 首次打开：若无缓存或已过期，静默抓一次下架数据
        fetchDeprecationDoc(false).then(cache => {
            const changed = cache !== deprecationCache;
            deprecationCache = cache;
            if (changed) render();
        }).catch(e => console.warn(`${LOG_PREFIX} 下架数据抓取失败`, e));
    }

    // ============================================================
    // 启动
    // ============================================================
    function boot() {
        injectStyles();
        createFab();
        console.log(`${LOG_PREFIX} 已启动，已存 ${Object.keys(store.getApps()).length} 条`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
