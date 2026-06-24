
// 部署完成后在网址后面加上这个，获取自建节点和机场聚合节点，/?token=auto或/auto或

const DEFAULT_CONFIG = {
	token: 'auto',
	guestToken: '', //可以随便取，或者uuid生成，https://1024tools.com/uuid
	botToken: '', //可以为空，或者@BotFather中输入/start，/newbot，并关注机器人
	chatID: '', //可以为空，或者@userinfobot中获取，/start
	tg: 0, //小白勿动， 开发者专用，1 为推送所有的访问信息，0 为不推送订阅转换后端的访问信息与异常访问
	fileName: 'CF-Workers-SUB',
	subUpdateTime: 6, //自定义订阅更新时间，单位小时
	subRetry: 1, //订阅链接失败后的重试次数
	subTimeout: 5000, //单个订阅链接请求超时时间，单位毫秒
	subApiTimeout: 8000, //订阅转换后端请求超时时间，单位毫秒
	subApiStagger: 250, //多个订阅转换后端的错峰并发间隔，单位毫秒
	subCache: 300, //订阅结果缓存时间，单位秒
	showFailedSub: false,
	totalTB: 99,
	timestamp: 4102329600000, //2099-12-31
};

//节点链接 + 订阅链接
const DEFAULT_MAIN_DATA = `
https://cfxr.eu.org/getSub
`;

const DEFAULT_SUB_CONVERTER = "SUBAPI.cmliussss.net"; //在线订阅转换后端，目前使用CM的订阅转换功能。支持自建psub 可自行搭建https://github.com/bulianglin/psub
const DEFAULT_SUB_CONFIG = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini"; //订阅配置文件
const CUSTOM_FIX_VERSION = "custom-fix-2026-06-24-distinct-nginx";
// UA 轮换池：首轮用默认UA，重试时依次切换
// LINK.txt 内存缓存：避免每次请求读KV + 用户编辑后 30s 内生效
const LINK_TEXT_CACHE = { value: null, ts: 0 };
const LINK_TEXT_CACHE_TTL = 30000;
const UA_ROTATION_POOL = [
	"ClashMeta/1.18 (https://github.com/MetaCubeX/clash.meta)",
	"sing-box/1.10 (https://github.com/SagerNet/sing-box)",
	"Stash/3.0 (https://stash.ws)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
];
const BYTES_PER_TB = 1099511627776;
const SUB_CONVERTER_STRATEGY = "adaptive-latency-aware";
const SUB_CONVERTER_HEALTH_KEY = "__subapi_health_v1__";
const SUB_CONVERTER_HEALTH_LIMIT = 24;
const subConverterHealth = new Map();

function normalizeSubConverter(rawValue) {
	const value = String(rawValue || DEFAULT_SUB_CONVERTER).trim();
	if (value.startsWith('http://')) return { subProtocol: 'http', subConverter: value.slice('http://'.length).replace(/\/+$/, '') };
	if (value.startsWith('https://')) return { subProtocol: 'https', subConverter: value.slice('https://'.length).replace(/\/+$/, '') };
	return { subProtocol: 'https', subConverter: value.replace(/\/+$/, '') };
}

function normalizeSubConverters(rawValue) {
	const values = String(rawValue || DEFAULT_SUB_CONVERTER)
		.split(/[\n,|]+/)
		.map(value => value.trim())
		.filter(Boolean);
	return [...new Map(values.map(value => {
		const converter = normalizeSubConverter(value);
		return [`${converter.subProtocol}://${converter.subConverter}`, converter];
	})).values()];
}

function getConverterKey(converter) {
	return `${converter.subProtocol}://${converter.subConverter}`;
}

function getConverterHealth(converter) {
	const key = getConverterKey(converter);
	if (!subConverterHealth.has(key)) {
		subConverterHealth.set(key, {
			successCount: 0,
			failureCount: 0,
			totalLatency: 0,
			lastLatency: 0,
			lastUsedAt: 0,
			lastSuccessAt: 0,
			lastFailureAt: 0,
			consecutiveFailures: 0,
			updatedAt: 0,
		});
	}
	return subConverterHealth.get(key);
}

function getAverageLatency(stats) {
	return stats.successCount > 0 ? stats.totalLatency / stats.successCount : Number.POSITIVE_INFINITY;
}

function getConverterTier(stats) {
	if (stats.successCount > 0 && stats.consecutiveFailures === 0) return 0;
	if (stats.successCount === 0 && stats.failureCount === 0) return 1;
	return 2;
}

function compareNumbers(a, b) {
	return (a || 0) - (b || 0);
}

function prioritizeSubConverters(converters) {
	const orderMap = new Map(converters.map((converter, index) => [getConverterKey(converter), index]));
	return [...converters].sort((left, right) => {
		const leftStats = getConverterHealth(left);
		const rightStats = getConverterHealth(right);
		const leftOrder = orderMap.get(getConverterKey(left)) ?? 0;
		const rightOrder = orderMap.get(getConverterKey(right)) ?? 0;
		const tierDiff = getConverterTier(leftStats) - getConverterTier(rightStats);
		if (tierDiff !== 0) return tierDiff;

		if (getConverterTier(leftStats) === 0) {
			const leftAverage = getAverageLatency(leftStats);
			const rightAverage = getAverageLatency(rightStats);
			const latencyGap = Math.abs(leftAverage - rightAverage);
			if (latencyGap > 300) return leftAverage - rightAverage;
			const usageDiff = compareNumbers(leftStats.lastUsedAt, rightStats.lastUsedAt);
			if (usageDiff !== 0) return usageDiff;
			return leftAverage - rightAverage;
		}

		if (getConverterTier(leftStats) === 1) {
			const usageDiff = compareNumbers(leftStats.lastUsedAt, rightStats.lastUsedAt);
			if (usageDiff !== 0) return usageDiff;
			return leftOrder - rightOrder;
		}

		const failureDiff = leftStats.consecutiveFailures - rightStats.consecutiveFailures;
		if (failureDiff !== 0) return failureDiff;
		const retryDiff = compareNumbers(leftStats.lastFailureAt, rightStats.lastFailureAt);
		if (retryDiff !== 0) return retryDiff;
		const totalFailureDiff = leftStats.failureCount - rightStats.failureCount;
		if (totalFailureDiff !== 0) return totalFailureDiff;
		return leftOrder - rightOrder;
	});
}

function recordSubConverterResult(converter, isSuccess, latencyMs) {
	const stats = getConverterHealth(converter);
	const now = Date.now();
	stats.lastUsedAt = now;
	stats.updatedAt = now;
	if (Number.isFinite(latencyMs) && latencyMs >= 0) stats.lastLatency = latencyMs;

	if (isSuccess) {
		stats.successCount += 1;
		stats.consecutiveFailures = 0;
		stats.lastSuccessAt = now;
		if (Number.isFinite(latencyMs) && latencyMs >= 0) stats.totalLatency += latencyMs;
		return;
	}

	stats.failureCount += 1;
	stats.consecutiveFailures += 1;
	stats.lastFailureAt = now;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeStoredConverterStats(stats = {}) {
	return {
		successCount: Number(stats.successCount) || 0,
		failureCount: Number(stats.failureCount) || 0,
		totalLatency: Number(stats.totalLatency) || 0,
		lastLatency: Number(stats.lastLatency) || 0,
		lastUsedAt: Number(stats.lastUsedAt) || 0,
		lastSuccessAt: Number(stats.lastSuccessAt) || 0,
		lastFailureAt: Number(stats.lastFailureAt) || 0,
		consecutiveFailures: Number(stats.consecutiveFailures) || 0,
		updatedAt: Number(stats.updatedAt) || 0,
	};
}

async function loadPersistedSubConverterHealth(kv, converters, DEBUG = false) {
	if (!kv) return;
	try {
		const raw = await kv.get(SUB_CONVERTER_HEALTH_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
		for (const converter of converters) {
			const key = getConverterKey(converter);
			if (!entries[key]) continue;
			const currentStats = getConverterHealth(converter);
			const storedStats = normalizeStoredConverterStats(entries[key]);
			if (storedStats.updatedAt >= (currentStats.updatedAt || 0)) {
				subConverterHealth.set(key, storedStats);
			}
		}
		debugLog(DEBUG, `已加载订阅转换后端健康度: ${Object.keys(entries).length}`);
	} catch (error) {
		debugLog(DEBUG, '加载订阅转换后端健康度失败', error);
	}
}

function serializeSubConverterHealth(converters) {
	const candidateKeys = converters?.length
		? [...new Set(converters.map(converter => getConverterKey(converter)))]
		: [...subConverterHealth.keys()];
	const entries = candidateKeys
		.map(key => [key, normalizeStoredConverterStats(subConverterHealth.get(key))])
		.filter(([, stats]) => stats.successCount > 0 || stats.failureCount > 0)
		.sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0))
		.slice(0, SUB_CONVERTER_HEALTH_LIMIT);
	return Object.fromEntries(entries);
}

async function persistSubConverterHealth(kv, converters, DEBUG = false) {
	if (!kv) return;
	try {
		const entries = serializeSubConverterHealth(converters);
		await kv.put(SUB_CONVERTER_HEALTH_KEY, JSON.stringify({
			updatedAt: Date.now(),
			entries,
		}));
		debugLog(DEBUG, `已持久化订阅转换后端健康度: ${Object.keys(entries).length}`);
	} catch (error) {
		debugLog(DEBUG, '持久化订阅转换后端健康度失败', error);
	}
}

function isDebugEnabled(env) {
	return ['1', 'true', 'yes', 'on'].includes(String(env.DEBUG || '').toLowerCase());
}

function normalizeBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value === 'boolean') return value;
	return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function debugLog(debug, ...args) {
	if (debug) console.log(...args);
}

function normalizeNumber(value, fallback, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(number)));
}

function runInBackground(ctx, promise, DEBUG = false) {
	const task = Promise.resolve(promise).catch(error => debugLog(DEBUG, error));
	if (ctx?.waitUntil) ctx.waitUntil(task);
}

function runtimeHeaders(headers = {}, extra = {}) {
	const result = new Headers(headers);
	result.set("X-Custom-Fix-Version", CUSTOM_FIX_VERSION);
	for (const [key, value] of Object.entries(extra)) result.set(key, value);
	return result;
}

async function getSubscriptionCache(cacheKey, DEBUG = false) {
	if (!cacheKey || typeof caches === 'undefined') return null;
	const cached = await caches.default.match(cacheKey);
	if (!cached) return null;
	debugLog(DEBUG, `订阅缓存命中: ${cacheKey.url}`);
	const headers = runtimeHeaders(cached.headers, { "X-Sub-Cache": "HIT" });
	return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

function storeSubscriptionCache(cacheKey, response, subCache, ctx, DEBUG = false, cacheState = "MISS") {
	if (!cacheKey || !subCache || typeof caches === 'undefined' || response.status !== 200) return response;
	const cacheHeaders = runtimeHeaders(response.headers, {
		"Cache-Control": `public, max-age=${subCache}`,
		"X-Sub-Cache": cacheState,
	});
	const cacheableResponse = new Response(response.clone().body, {
		status: response.status,
		statusText: response.statusText,
		headers: cacheHeaders,
	});
	runInBackground(ctx, caches.default.put(cacheKey, cacheableResponse.clone()), DEBUG);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: cacheHeaders,
	});
}


// KV 持久化缓存：订阅结果写入 KV，冷启动后无需重新抓取全量订阅链接
const SUB_KV_PREFIX = "__sub:";
// 订阅失败回退缓存（内存，不写KV）
const staleCache = new Map(); // key: url, value: {content, expiresAt}

async function getSubFromKV(kv, cacheSeed) {
	if (!kv) return null;
	try {
		const key = SUB_KV_PREFIX + await MD5MD5(cacheSeed);
		const cached = await kv.get(key);
		if (cached) return cached;
	} catch (e) { /* KV 读取失败静默降级 */ }
	return null;
}

function putSubToKV(kv, cacheSeed, data, ttl, ctx) {
	if (!kv || !ttl) return;
	runInBackground(ctx, (async () => {
		try {
			const key = SUB_KV_PREFIX + await MD5MD5(cacheSeed);
			await kv.put(key, data, { expirationTtl: Math.max(ttl, 60) });
		} catch (e) { /* KV 写入失败静默降级 */ }
	})(), false);
}
export default {
	async fetch(request, env, ctx) {
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const url = new URL(request.url);
		const token = url.searchParams.get('token');
		const DEBUG = isDebugEnabled(env);
		const mytoken = env.TOKEN || DEFAULT_CONFIG.token;
		const BotToken = env.TGTOKEN || DEFAULT_CONFIG.botToken;
		const ChatID = env.TGID || DEFAULT_CONFIG.chatID;
		const TG = Number(env.TG ?? DEFAULT_CONFIG.tg);
		const subConverters = normalizeSubConverters(env.SUBAPI || DEFAULT_SUB_CONVERTER);
		const subConverterDisplay = subConverters.map(item => `${item.subProtocol}://${item.subConverter}`).join(', ');
		const subConverterStateBackend = env.KV ? 'KV' : 'MEMORY';
		const subConfig = env.SUBCONFIG || DEFAULT_SUB_CONFIG;
		const FileName = env.SUBNAME || DEFAULT_CONFIG.fileName;
		const subRetry = normalizeNumber(env.SUBRETRY, DEFAULT_CONFIG.subRetry, 0, 5);
		const subTimeout = normalizeNumber(env.SUBTIMEOUT, DEFAULT_CONFIG.subTimeout, 1000, 30000);
		const subApiTimeout = normalizeNumber(env.SUBAPITIMEOUT, DEFAULT_CONFIG.subApiTimeout, 1000, 30000);
		const subApiStagger = normalizeNumber(env.SUBAPISTAGGER, DEFAULT_CONFIG.subApiStagger, 0, 3000);
		const subCache = normalizeNumber(env.SUBCACHE, DEFAULT_CONFIG.subCache, 0, 3600);
		const showFailedSub = normalizeBoolean(env.SHOW_FAILED_SUB, DEFAULT_CONFIG.showFailedSub);
		const refreshCache = url.searchParams.has('refresh');

		const currentDate = new Date();
		currentDate.setHours(0, 0, 0, 0);
		const timeTemp = Math.ceil(currentDate.getTime() / 1000);
		const fakeToken = await MD5MD5(`${mytoken}${timeTemp}`);
		let guestToken = env.GUESTTOKEN || env.GUEST || DEFAULT_CONFIG.guestToken;
		if (!guestToken) guestToken = await MD5MD5(mytoken);
		const 访客订阅 = guestToken;

		const timestamp = DEFAULT_CONFIG.timestamp;
		const total = DEFAULT_CONFIG.totalTB * BYTES_PER_TB;
		let UD = Math.floor(((timestamp - Date.now()) / timestamp * total) / 2);
		let expire = Math.floor(timestamp / 1000);
		const SUBUpdateTime = env.SUBUPTIME || DEFAULT_CONFIG.subUpdateTime;

		if (!([mytoken, fakeToken, 访客订阅].includes(token) || url.pathname == ("/" + mytoken) || url.pathname.includes("/" + mytoken + "?"))) {
			if (env.ASSETS && url.pathname.includes('.')) {
				const assetResponse = await env.ASSETS.fetch(request);
				if (assetResponse.status !== 404) return assetResponse;
			}
			if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") runInBackground(ctx, sendMessage(`#异常访问 ${FileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgent}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname + url.search}</tg-spoiler>`, { BotToken, ChatID }), DEBUG);
			if (env.URL302) return Response.redirect(env.URL302, 302);
			else if (env.URL) return await proxyURL(env.URL, url, DEBUG);
			else return new Response(await nginx(), {
				status: 200,
				headers: runtimeHeaders({
					'Content-Type': 'text/html; charset=UTF-8',
				}),
			});
		} else {
			// KV converter health persistence disabled per request to reduce KV ops
		// if (subConverters.length > 0) await loadPersistedSubConverterHealth(env.KV, subConverters, DEBUG);
			let MainData = DEFAULT_MAIN_DATA;
		let rawLinkContent = MainData;
			let urls = [];
			if (env.KV) {
				await 迁移地址列表(env, 'LINK.txt');
				if (userAgent.includes('mozilla') && !url.search) {
					runInBackground(ctx, sendMessage(`#编辑订阅 ${FileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname + url.search}</tg-spoiler>`, { BotToken, ChatID }), DEBUG);
					return await KV(request, env, 'LINK.txt', 访客订阅, { FileName, mytoken, subConverterDisplay, subConverterStateBackend, subConfig, subRetry, subTimeout, subApiTimeout, subApiStagger, subCache, showFailedSub });
				} else {
					const now = Date.now();
				if (now - LINK_TEXT_CACHE.ts > LINK_TEXT_CACHE_TTL) {
					LINK_TEXT_CACHE.value = await env.KV.get('LINK.txt');
					LINK_TEXT_CACHE.ts = now;
				}
				MainData = LINK_TEXT_CACHE.value ?? DEFAULT_MAIN_DATA;
				rawLinkContent = MainData;
				}
			} else {
				MainData = env.LINK || DEFAULT_MAIN_DATA;
				rawLinkContent = MainData;
				if (env.LINKSUB) urls = await ADD(env.LINKSUB);
			}
			let 重新汇总所有链接 = await ADD(MainData + '\n' + urls.join('\n'));
			let 自建节点 = "";
			let 订阅链接 = "";
			for (let x of 重新汇总所有链接) {
				if (x.toLowerCase().startsWith('http')) {
					订阅链接 += x + '\n';
				} else {
					自建节点 += x + '\n';
				}
			}
			MainData = 自建节点;
			urls = await ADD(订阅链接);
			runInBackground(ctx, sendMessage(`#获取订阅 ${FileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname + url.search}</tg-spoiler>`, { BotToken, ChatID }), DEBUG);
			const isSubConverterRequest = request.headers.get('subconverter-request') || request.headers.get('subconverter-version') || userAgent.includes('subconverter');
			let 订阅格式 = 'base64';
			if (!(userAgent.includes('null') || isSubConverterRequest || userAgent.includes('nekobox') || userAgent.includes(('CF-Workers-SUB').toLowerCase()))) {
				if (userAgent.includes('sing-box') || userAgent.includes('singbox') || url.searchParams.has('sb') || url.searchParams.has('singbox')) {
					订阅格式 = 'singbox';
				} else if (userAgent.includes('surge') || url.searchParams.has('surge')) {
					订阅格式 = 'surge';
				} else if (userAgent.includes('quantumult') || url.searchParams.has('quanx')) {
					订阅格式 = 'quanx';
				} else if (userAgent.includes('loon') || url.searchParams.has('loon')) {
					订阅格式 = 'loon';
				} else if (userAgent.includes('clash') || userAgent.includes('meta') || userAgent.includes('mihomo') || url.searchParams.has('clash')) {
					订阅格式 = 'clash';
				}
			}

			let subConverterUrl;
			const 订阅转换基础URL = `${url.origin}/${await MD5MD5(fakeToken)}?token=${fakeToken}`;
			let 订阅转换URL = 订阅转换基础URL;
			let req_data = MainData;

			let 追加UA = 'v2rayn';
			if (url.searchParams.has('b64') || url.searchParams.has('base64')) 订阅格式 = 'base64';
			else if (url.searchParams.has('clash')) 追加UA = 'clash';
			else if (url.searchParams.has('singbox')) 追加UA = 'singbox';
			else if (url.searchParams.has('surge')) 追加UA = 'surge';
			else if (url.searchParams.has('quanx')) 追加UA = 'Quantumult%20X';
			else if (url.searchParams.has('loon')) 追加UA = 'Loon';

			const 订阅链接数组 = [...new Set(urls)].filter(item => item?.trim?.()); // 去重
			let selectedSubConverter = '';
			let subStatus = [];
			if (订阅链接数组.length > 0) {
				const 请求订阅响应内容 = await getSUB(订阅链接数组, 追加UA, userAgentHeader, { DEBUG, subRetry, subTimeout, showFailedSub, subConverters, kv: env.KV, ctx });
				debugLog(DEBUG, 请求订阅响应内容);
				subStatus = 请求订阅响应内容[2] || [];
				req_data += 请求订阅响应内容[0].join('\n');
				订阅转换URL += "|" + 请求订阅响应内容[1];
				if (订阅格式 == 'base64' && !isSubConverterRequest && 请求订阅响应内容[1].includes('://')) {
					try {
						const { text: subConverterContent, converter: mixedSubConverter } = await fetchSubConverterText(subConverters, converter => buildSubConverterUrl(converter, 'mixed', 请求订阅响应内容[1], subConfig), { 'User-Agent': 'v2rayN/CF-Workers-SUB  (https://github.com/cmliu/CF-Workers-SUB)' }, { DEBUG, subApiTimeout, subApiStagger, kv: env.KV, ctx });
						if (mixedSubConverter) selectedSubConverter = mixedSubConverter;
						req_data += '\n' + atob(subConverterContent);
					} catch (error) {
						debugLog(DEBUG, '订阅转换请回base64失败，检查订阅转换后端是否正常运行', error);
					}
				}
			}

			if (env.WARP) 订阅转换URL += "|" + (await ADD(env.WARP)).join("|");
			const sourceFingerprint = await MD5MD5([
				req_data,
				订阅转换URL,
				订阅格式,
				subConverterDisplay,
				subConfig,
				rawLinkContent || '',
			].join('\n---\n'));
			订阅转换URL = `${订阅转换基础URL}&src=${sourceFingerprint}` + 订阅转换URL.slice(订阅转换基础URL.length);

			const cacheUrl = new URL(request.url);
			cacheUrl.searchParams.delete('refresh');
			const cacheSeed = [
				cacheUrl.toString(),
				订阅格式,
				sourceFingerprint,
				env.WARP || '',
				subConverterDisplay,
				subConfig,
				rawLinkContent || '',
			].join('\n---\n');
			const cacheKey = request.method === "GET" && subCache > 0
				? new Request(`${url.origin}/__sub-cache/${await MD5MD5(cacheSeed)}`, { method: "GET" })
				: null;
			const cachedResponse = refreshCache ? null : await getSubscriptionCache(cacheKey, DEBUG);
			// KV 缓存回退：仅在 SUBCACHE < 300 时使用，避免频繁读写KV
			let kvCachedBase64 = null;
			if (!cachedResponse && env.KV && subCache < 300) {
				kvCachedBase64 = await getSubFromKV(env.KV, cacheSeed);
			}
			if (cachedResponse) return cachedResponse;
			//修复中文错误
			const utf8Encoder = new TextEncoder();
			const encodedData = utf8Encoder.encode(req_data);
			//const text = String.fromCharCode.apply(null, encodedData);
			const utf8Decoder = new TextDecoder();
			const text = utf8Decoder.decode(encodedData);

			//去重
			const uniqueLines = new Set(text.split('\n'));
			const result = [...uniqueLines].join('\n');
			let base64Data = kvCachedBase64 || null;
			if (!base64Data) {
			try {
				base64Data = btoa(result);
			} catch (e) {
				function encodeBase64(data) {
					const binary = new TextEncoder().encode(data);
					let base64 = '';
					const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

					for (let i = 0; i < binary.length; i += 3) {
						const byte1 = binary[i];
						const byte2 = binary[i + 1] || 0;
						const byte3 = binary[i + 2] || 0;

						base64 += chars[byte1 >> 2];
						base64 += chars[((byte1 & 3) << 4) | (byte2 >> 4)];
						base64 += chars[((byte2 & 15) << 2) | (byte3 >> 6)];
						base64 += chars[byte3 & 63];
					}

					const padding = 3 - (binary.length % 3 || 3);
					return base64.slice(0, base64.length - padding) + '=='.slice(0, padding);
				}

				base64Data = encodeBase64(result)
			}
			} // end if (!base64Data)

			// 写入 KV 持久化缓存（异步，不阻塞响应）
			// 仅在冷启动时写KV缓存（减少KV写入）
			if (!kvCachedBase64 && subCache < 300) {
			putSubToKV(env.KV, cacheSeed, base64Data, subCache, ctx);
			}

			// 构建响应头对象
			const responseHeaders = {
				"content-type": "text/plain; charset=utf-8",
				"Profile-Update-Interval": `${SUBUpdateTime}`,
				"Profile-web-page-url": request.url.includes('?') ? request.url.split('?')[0] : request.url,
				//"Subscription-Userinfo": `upload=${UD}; download=${UD}; total=${total}; expire=${expire}`,
			};
			responseHeaders["X-Sub-Source-Fingerprint"] = sourceFingerprint;
			if (selectedSubConverter) responseHeaders["X-Sub-Converter"] = selectedSubConverter;
			responseHeaders["X-Sub-Converter-Strategy"] = SUB_CONVERTER_STRATEGY;
			if (subStatus && subStatus.length) responseHeaders["X-Sub-Fetch-Status"] = subStatus.join("; ");
			responseHeaders["X-Sub-Converter-State"] = subConverterStateBackend;

			if (订阅格式 == 'base64' || token == fakeToken) {
				const response = new Response(base64Data, { headers: runtimeHeaders(responseHeaders) });
				return storeSubscriptionCache(cacheKey, response, subCache, ctx, DEBUG, refreshCache ? "REFRESH" : "MISS");
			} else if (订阅格式 == 'clash') {
				subConverterUrl = converter => buildSubConverterUrl(converter, 'clash', 订阅转换URL, subConfig);
			} else if (订阅格式 == 'singbox') {
				subConverterUrl = converter => buildSubConverterUrl(converter, 'singbox', 订阅转换URL, subConfig);
			} else if (订阅格式 == 'surge') {
				subConverterUrl = converter => buildSubConverterUrl(converter, 'surge', 订阅转换URL, subConfig, 'ver=4');
			} else if (订阅格式 == 'quanx') {
				subConverterUrl = converter => buildSubConverterUrl(converter, 'quanx', 订阅转换URL, subConfig, 'udp=true');
			} else if (订阅格式 == 'loon') {
				subConverterUrl = converter => buildSubConverterUrl(converter, 'loon', 订阅转换URL, subConfig);
			}
			try {
				const converterResult = await fetchSubConverterText(subConverters, subConverterUrl, { 'User-Agent': userAgentHeader }, { DEBUG, subApiTimeout, subApiStagger, kv: env.KV, ctx });//订阅转换
				selectedSubConverter = converterResult.converter || selectedSubConverter;
				responseHeaders["X-Sub-Converter"] = selectedSubConverter;
				let subConverterContent = converterResult.text;
				if (订阅格式 == 'clash') subConverterContent = await clashFix(subConverterContent);
				// 只有非浏览器订阅才会返回SUBNAME
				const headers = runtimeHeaders(responseHeaders);
				if (!userAgent.includes('mozilla')) headers.set("Content-Disposition", `attachment; filename*=utf-8''${encodeURIComponent(FileName)}`);
				const response = new Response(subConverterContent, { headers });
				return storeSubscriptionCache(cacheKey, response, subCache, ctx, DEBUG, refreshCache ? "REFRESH" : "MISS");
			} catch (error) {
				return new Response(base64Data, { headers: runtimeHeaders(responseHeaders, { "X-Sub-Cache": "BYPASS" }) });
			}
		}
	}
};

function splitLinkText(envadd) {
	if (!envadd) return [];
	const addtext = String(envadd).replace(/[	"'|\r\n]+/g, '\n').replace(/\n+/g, '\n').trim();
	if (!addtext) return [];
	return addtext.split('\n').map(item => item.trim()).filter(Boolean);
}

function summarizeLinks(envadd) {
	const lines = splitLinkText(envadd);
	const remote = lines.filter(item => item.toLowerCase().startsWith('http')).length;
	return { total: lines.length, remote, local: lines.length - remote };
}

async function ADD(envadd) {
	const add = splitLinkText(envadd);
	return add;
}

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
		h1 { color: #1a73e8; }
		.footer { color: #999; font-size: 12px; margin-top: 2em; }
		.highlight { background: linear-gradient(90deg, #1a73e8, #34a853); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
	<p class="highlight">Powered by Cloudflare Workers</p>
	<hr>
	<p class="footer"><em>Thank you for using nginx.</em> &middot; Custom Edition</p>
	</body>
	</html>
	`;
	return text;
}

async function sendMessage(type, ip, add_data = "", config = {}) {
	const { BotToken = '', ChatID = '' } = config;
	if (BotToken !== '' && ChatID !== '') {
		let msg = "";
		const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN`);
		if (response.status == 200) {
			const ipInfo = await response.json();
			msg = `${type}\nIP: ${ip}\n国家: ${ipInfo.country}\n<tg-spoiler>城市: ${ipInfo.city}\n组织: ${ipInfo.org}\nASN: ${ipInfo.as}\n${add_data}`;
		} else {
			msg = `${type}\nIP: ${ip}\n<tg-spoiler>${add_data}`;
		}

		let url = "https://api.telegram.org/bot" + BotToken + "/sendMessage?chat_id=" + ChatID + "&parse_mode=HTML&text=" + encodeURIComponent(msg);
		return fetch(url, {
			method: 'get',
			headers: {
				'Accept': 'text/html,application/xhtml+xml,application/xml;',
				'Accept-Encoding': 'gzip, deflate, br',
				'User-Agent': 'Mozilla/5.0 Chrome/90.0.4430.72'
			}
		});
	}
}

function base64Decode(str) {
	const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
	const decoder = new TextDecoder('utf-8');
	return decoder.decode(bytes);
}

function tryDecodeBase64(str) {
	const raw = String(str || '');
	if (!raw) return null;
	// 方案1：标准base64（剥除非base64字符后重试）
	const stdClean = raw.replace(/[^A-Za-z0-9+/=]/g, '');
	if (stdClean && stdClean.length % 4 !== 1) {
		try {
			const decoded = base64Decode(stdClean);
			if (decoded && /[a-z]+:\/\//.test(decoded)) return decoded;
		} catch (_) {}
	}
	// 方案2：URL-safe base64（- 替换为 +, _ 替换为 /）
	const urlClean = raw.replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
	if (urlClean && urlClean.length % 4 !== 1) {
		try {
			const decoded = base64Decode(urlClean);
			if (decoded && /[a-z]+:\/\//.test(decoded)) return decoded;
		} catch (_) {}
	}
	// 方案3：保留原始严格检查（兼容旧行为）
	const strictClean = raw.replace(/\s/g, '');
	if (strictClean && strictClean.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(strictClean)) {
		try { return base64Decode(strictClean); } catch (_) {}
	}
	return null;
}

async function MD5MD5(text) {
	const encoder = new TextEncoder();

	const firstPass = await crypto.subtle.digest('MD5', encoder.encode(text));
	const firstPassArray = Array.from(new Uint8Array(firstPass));
	const firstHex = firstPassArray.map(b => b.toString(16).padStart(2, '0')).join('');

	const secondPass = await crypto.subtle.digest('MD5', encoder.encode(firstHex.slice(7, 27)));
	const secondPassArray = Array.from(new Uint8Array(secondPass));
	const secondHex = secondPassArray.map(b => b.toString(16).padStart(2, '0')).join('');

	return secondHex.toLowerCase();
}

function clashFix(content) {
	if (content.includes('wireguard') && !content.includes('remote-dns-resolve')) {
		let lines;
		if (content.includes('\r\n')) {
			lines = content.split('\r\n');
		} else {
			lines = content.split('\n');
		}

		let result = "";
		for (let line of lines) {
			if (line.includes('type: wireguard')) {
				const 备改内容 = `, mtu: 1280, udp: true`;
				const 正确内容 = `, mtu: 1280, remote-dns-resolve: true, udp: true`;
				result += line.replace(new RegExp(备改内容, 'g'), 正确内容) + '\n';
			} else {
				result += line + '\n';
			}
		}

		content = result;
	}
	return content;
}

function buildSubConverterUrl(converter, target, sourceUrl, subConfig, extraQuery = '') {
	const extra = extraQuery ? `&${extraQuery}` : '';
	return `${converter.subProtocol}://${converter.subConverter}/sub?target=${target}${extra}&url=${encodeURIComponent(sourceUrl)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
}

async function requestSubConverter(converter, buildUrl, headers, options = {}) {
	const { DEBUG = false, subApiTimeout = DEFAULT_CONFIG.subApiTimeout } = options;
	const converterUrl = buildUrl(converter);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), subApiTimeout);
	const startedAt = Date.now();
	try {
		const response = await fetch(converterUrl, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const latencyMs = Date.now() - startedAt;
		recordSubConverterResult(converter, true, latencyMs);
		debugLog(DEBUG, `订阅转换成功: ${converter.subProtocol}://${converter.subConverter} ${latencyMs}ms`);
		return { text: await response.text(), converter: getConverterKey(converter), latencyMs };
	} catch (error) {
		recordSubConverterResult(converter, false, Date.now() - startedAt);
		debugLog(DEBUG, `订阅转换失败: ${converterUrl}`, error);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchSubConverterText(converters, buildUrl, headers, options = {}) {
	const { DEBUG = false, subApiTimeout = DEFAULT_CONFIG.subApiTimeout, subApiStagger = DEFAULT_CONFIG.subApiStagger, kv = null, ctx = null } = options;
	const prioritizedConverters = prioritizeSubConverters(converters);
	if (prioritizedConverters.length === 0) throw new Error('未配置订阅转换后端');

	try {
		if (prioritizedConverters.length === 1 || subApiStagger === 0) {
			let lastError;
			for (const converter of prioritizedConverters) {
				try {
					return await requestSubConverter(converter, buildUrl, headers, { DEBUG, subApiTimeout });
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError || new Error('所有订阅转换后端均不可用');
		}

		const delayedRequests = prioritizedConverters.map((converter, index) => (async () => {
			const delayMs = index * subApiStagger;
			if (delayMs > 0) await sleep(delayMs);
			return requestSubConverter(converter, buildUrl, headers, { DEBUG, subApiTimeout });
		})());

		return await Promise.any(delayedRequests);
	} catch (error) {
		const lastError = error?.errors?.[error.errors.length - 1];
		throw lastError || error || new Error('所有订阅转换后端均不可用');
	} finally {
		// KV converter health persistence disabled - use in-memory only
		// runInBackground(ctx, persistSubConverterHealth(kv, prioritizedConverters, DEBUG), DEBUG);
	}
}

async function proxyURL(proxyURL, url, DEBUG = false) {
	const URLs = await ADD(proxyURL);
	const fullURL = URLs[Math.floor(Math.random() * URLs.length)];

	// 解析目标 URL
	let parsedURL = new URL(fullURL);
	debugLog(DEBUG, parsedURL);
	// 提取并可能修改 URL 组件
	let URLProtocol = parsedURL.protocol.slice(0, -1) || 'https';
	let URLHostname = parsedURL.hostname;
	let URLPathname = parsedURL.pathname;
	let URLSearch = parsedURL.search;

	// 处理 pathname
	if (URLPathname.charAt(URLPathname.length - 1) == '/') {
		URLPathname = URLPathname.slice(0, -1);
	}
	URLPathname += url.pathname;

	// 构建新的 URL
	let newURL = `${URLProtocol}://${URLHostname}${URLPathname}${URLSearch}`;

	// 反向代理请求
	let response = await fetch(newURL);

	// 创建新的响应
	let newResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});

	// 添加自定义头部，包含 URL 信息
	//newResponse.headers.set('X-Proxied-By', 'Cloudflare Worker');
	//newResponse.headers.set('X-Original-URL', fullURL);
	newResponse.headers.set('X-New-URL', newURL);

	return newResponse;
}

// 熔断机制: 连续失败超过阈值的订阅链接暂时跳过
const circuitBreaker = new Map(); // key: url, value: {failures, cooldownUntil}
const CIRCUIT_COOLDOWN_MS = 300000; // 5分钟冷却期
const FETCH_CONCURRENCY = 8; // 每批并发数

async function getSUB(api, 追加UA, userAgentHeader, options = {}) {
	const { DEBUG = false, subRetry = DEFAULT_CONFIG.subRetry, subTimeout = DEFAULT_CONFIG.subTimeout, showFailedSub = DEFAULT_CONFIG.showFailedSub, subConverters = null, kv = null, ctx = null } = options;
	if (!api || api.length === 0) {
		return [];
	} else api = [...new Set(api)]; // 去重
	let newapi = "";
	let 订阅转换URLs = "";
	let 异常订阅 = "";
	let subStatus = [];

	try {
		// 分批并发抓取，避免瞬间洪峰 + 熔断检查
		const now = Date.now();
		const activeUrls = [];
		for (const apiUrl of api) {
			const cb = circuitBreaker.get(apiUrl);
			if (cb && cb.cooldownUntil > now) {
				subStatus.push(apiUrl + ' CIRCUIT_OPEN');
				debugLog(DEBUG, `熔断跳过: ${apiUrl}`);
				continue;
			}
			activeUrls.push(apiUrl);
		}
		const responses = [];
		for (let i = 0; i < activeUrls.length; i += FETCH_CONCURRENCY) {
			const batch = activeUrls.slice(i, i + FETCH_CONCURRENCY);
			const batchResults = await Promise.allSettled(batch.map(apiUrl => fetchSubscription(apiUrl, 追加UA, userAgentHeader, { DEBUG, subRetry, subTimeout })));
			batchResults.forEach((result, j) => {
				responses.push({ apiUrl: batch[j], result });
			});
		}

		// 遍历所有响应
		const modifiedResponses = responses.map((item) => {
			const apiUrl = item.apiUrl;
			const settled = item.result;
			// 检查是否请求成功
			if (settled.status === 'rejected') {
				const reason = settled.reason;
				// 熔断: 记录失败次数
				const cb = circuitBreaker.get(apiUrl) || { failures: 0, cooldownUntil: 0 };
				cb.failures++;
				if (cb.failures > subRetry) {
					cb.cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
				}
				circuitBreaker.set(apiUrl, cb);
				if (reason && reason.name === 'AbortError') {
					subStatus.push(apiUrl + " TIMEOUT");
					return { status: '超时', value: null, apiUrl };
				}
				subStatus.push(apiUrl + " FAIL " + (reason.status || reason.name || "unknown"));
				debugLog(DEBUG, `请求失败: ${apiUrl}, 错误信息: ${reason.status} ${reason.statusText}`);
				return { status: '请求失败', value: null, apiUrl };
			}
			// 成功: 重置熔断计数
			circuitBreaker.delete(apiUrl);
			return { status: settled.status, value: settled.value, apiUrl };
		});

		debugLog(DEBUG, modifiedResponses); // 输出修改后的响应数组

		for (const response of modifiedResponses) {
			// 检查响应状态是否为'fulfilled'
			if (response.status === 'fulfilled') {
				subStatus.push(response.apiUrl + " OK");
				const content = await response.value || 'null'; // 获取响应的内容
				if (content.includes('proxies:')) {
					订阅转换URLs += "|" + response.apiUrl; // Clash 配置
				} else if (content.includes('outbounds"') && content.includes('inbounds"')) {
					订阅转换URLs += "|" + response.apiUrl; // Singbox 配置
				} else if (content.includes('://')) {
					newapi += content + '\n'; // 追加内容
				} else {
					const decodedContent = tryDecodeBase64(content);
					if (decodedContent !== null) {
						newapi += decodedContent + '\n'; // 解码并追加内容
					} else {
						// fallback: extract :// URIs from raw response
						const rawLines = String(content || "").split(/[\r\n]+/);
						let hasExtractedNodes = false;
						for (const rawLine of rawLines) {
							if (/^[a-z]+:\/\//i.test(rawLine.trim())) {
								newapi += rawLine.trim() + "\n";
								hasExtractedNodes = true;
							}
						}
						if (!hasExtractedNodes) {
						const 异常订阅LINK = `trojan://CMLiussss@127.0.0.1:8888?security=tls&allowInsecure=1&type=tcp&headerType=none#%E5%BC%82%E5%B8%B8%E8%AE%A2%E9%98%85%20${response.apiUrl.split('://')[1].split('/')[0]}`;
						debugLog(DEBUG, '异常订阅: ' + 异常订阅LINK);
						if (showFailedSub) 异常订阅 += `${异常订阅LINK}\n`;
						}
					}
				}
			}
		}
		// 成功抓取的内容存入内存 stale cache（不写KV）
		for (const response of modifiedResponses) {
			if (response.status === 'fulfilled' && response.value) {
				const staleContent = String(response.value || '').slice(0, 65536);
				staleCache.set(response.apiUrl, { content: staleContent, expiresAt: Date.now() + 86400000 });
			}
		}
		// SUBAPI代理公底: 直连失败的订阅改走 SUBAPI 代为抓取
		if (subConverters && subConverters.length > 0) {
			const failedUrls = modifiedResponses.filter(r => r.status !== 'fulfilled');
			for (const failed of failedUrls) {
				const converter = subConverters[0]; // 选第一个可用的 SUBAPI
				const proxyUrl = `${converter.subProtocol}://${converter.subConverter}/sub?target=auto&url=${encodeURIComponent(failed.apiUrl)}&insert=false`;
				try {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), subTimeout);
					const proxyResp = await fetch(proxyUrl, { headers: { 'User-Agent': userAgentHeader || `v2rayN/CF-Workers-SUB` }, signal: controller.signal });
					clearTimeout(timer);
					if (!proxyResp.ok) throw new Error(`SUBAPI HTTP ${proxyResp.status}`);
					const proxyContent = await proxyResp.text();
					const decoded = tryDecodeBase64(proxyContent);
					if (decoded) {
						newapi += decoded + '\n';
						subStatus[subStatus.findIndex(s => s.startsWith(failed.apiUrl))] = failed.apiUrl + ' SUBAPI_OK';
					} else if (/^[a-z]+:\/\//im.test(proxyContent)) {
						newapi += proxyContent + '\n';
						subStatus[subStatus.findIndex(s => s.startsWith(failed.apiUrl))] = failed.apiUrl + ' SUBAPI_OK';
					} else {
						subStatus[subStatus.findIndex(s => s.startsWith(failed.apiUrl))] = failed.apiUrl + ' SUBAPI_FAIL';
					}
				} catch (e) {
					debugLog(DEBUG, `SUBAPI fallback failed for ${failed.apiUrl}:`, e.message || e);
				}
			}
		}
		// SUBAPI 也失败的订阅：尝试从内存 stale cache 恢复
		for (const response of modifiedResponses) {
			if (response.status !== 'fulfilled' && response.apiUrl) {
				const cached = staleCache.get(response.apiUrl);
				if (cached && cached.expiresAt > Date.now() && cached.content) {
					response.value = cached.content;
					response.status = 'fulfilled';
					response.fromStale = true;
				}
			}
		}
		// 从 stale cache 恢复的响应，立即在本轮处理
		for (const response of modifiedResponses) {
			if (response.fromStale && response.value) {
				const staleContent = response.value;
				const decoded = tryDecodeBase64(staleContent);
				if (decoded) {
					newapi += decoded + '\n';
				} else if (/^[a-z]+:\/\//im.test(staleContent)) {
					newapi += staleContent + '\n';
				}
				subStatus[subStatus.findIndex(s => s.startsWith(response.apiUrl))] = response.apiUrl + ' STALE_CACHE';
			}
		}
	} catch (error) {
		debugLog(DEBUG, error); // 捕获并输出错误信息
	}

	const 订阅内容 = await ADD(newapi + 异常订阅); // 将处理后的内容转换为数组
	// 返回处理后的结果
	return [订阅内容, 订阅转换URLs, subStatus];
}

async function fetchSubscription(targetUrl, 追加UA, userAgentHeader, options = {}) {
	const { DEBUG = false, subRetry = DEFAULT_CONFIG.subRetry, subTimeout = DEFAULT_CONFIG.subTimeout } = options;
	let lastError;
	for (let attempt = 0; attempt <= subRetry; attempt++) {
		// 首轮用默认UA，重试时轮换到备选UA
		const effectiveUA = attempt === 0 ? 追加UA : (UA_ROTATION_POOL[(attempt - 1) % UA_ROTATION_POOL.length]);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), subTimeout);
		try {
			const response = await getUrl(targetUrl, effectiveUA, userAgentHeader, controller.signal, DEBUG);
			if (!response.ok) throw response;
			return await response.text();
		} catch (error) {
			lastError = error;
			debugLog(DEBUG, `订阅请求失败 ${targetUrl} attempt=${attempt + 1}/${subRetry + 1}`, error?.status || error?.name || error);
			if (attempt >= subRetry) throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
	throw lastError;
}

async function getUrl(targetUrl, 追加UA, userAgentHeader, signal, DEBUG = false) {
	// 设置自定义 User-Agent
	const newHeaders = new Headers();
	newHeaders.set("User-Agent", `${atob('djJyYXlOLzYuNDU=')} cmliu/CF-Workers-SUB ${追加UA}(${userAgentHeader})`);
	newHeaders.set("Accept", "text/plain, application/json, application/yaml, */*");

	// 构建新的请求对象
	const modifiedRequest = new Request(targetUrl, {
		method: "GET",
		headers: newHeaders,
		redirect: "follow",
		signal,
		cf: {
			// 忽略SSL证书验证
			insecureSkipVerify: true,
			// 允许自签名证书
			allowUntrusted: true,
			// 禁用证书验证
			validateCertificate: false
		}
	});

	// 输出请求的详细信息
	debugLog(DEBUG, `请求URL: ${targetUrl}`);
	debugLog(DEBUG, `请求头: ${JSON.stringify([...newHeaders])}`);
	debugLog(DEBUG, "请求方法: GET");

	// 发送请求并返回响应
	return fetch(modifiedRequest);
}

async function 迁移地址列表(env, txt = 'ADD.txt') {
	const 旧数据 = await env.KV.get(`/${txt}`);
	const 新数据 = await env.KV.get(txt);

	if (旧数据 && !新数据) {
		// 写入新位置
		await env.KV.put(txt, 旧数据);
		// 删除旧数据
		await env.KV.delete(`/${txt}`);
		return true;
	}
	return false;
}

async function KV(request, env, txt = 'ADD.txt', guest, config = {}) {
	const {
		FileName = DEFAULT_CONFIG.fileName,
		mytoken = DEFAULT_CONFIG.token,
		subConverterDisplay = `https://${DEFAULT_SUB_CONVERTER}`,
		subConverterStateBackend = 'MEMORY',
		subConfig = DEFAULT_SUB_CONFIG,
		subRetry = DEFAULT_CONFIG.subRetry,
		subTimeout = DEFAULT_CONFIG.subTimeout,
		subApiTimeout = DEFAULT_CONFIG.subApiTimeout,
		subApiStagger = DEFAULT_CONFIG.subApiStagger,
		subCache = DEFAULT_CONFIG.subCache,
		showFailedSub = DEFAULT_CONFIG.showFailedSub,
	} = config;
	const url = new URL(request.url);
	try {
		// POST请求处理
		if (request.method === "POST") {
			if (!env.KV) return new Response("未绑定KV空间", { status: 400 });
			try {
				const content = await request.text();
				await env.KV.put(txt, content);
				return new Response("保存成功");
			} catch (error) {
				console.error('保存KV时发生错误:', error);
				return new Response("保存失败: " + error.message, { status: 500 });
			}
		}

		// GET请求部分
		let content = '';
		let hasKV = !!env.KV;

		if (hasKV) {
			try {
				content = await env.KV.get(txt) || '';
			} catch (error) {
				console.error('读取KV时发生错误:', error);
				content = '读取数据时发生错误: ' + error.message;
			}
		}
		const stats = summarizeLinks(content);

		const html = `
			<!DOCTYPE html>
			<html>
				<head>
					<title>${FileName} 订阅编辑</title>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width, initial-scale=1">
					<style>
						body {
							margin: 0;
							padding: 15px; /* 调整padding */
							box-sizing: border-box;
							font-size: 13px; /* 设置全局字体大小 */
						}
						.editor-container {
							width: 100%;
							max-width: 100%;
							margin: 0 auto;
						}
						.editor {
							width: 100%;
							height: 300px; /* 调整高度 */
							margin: 15px 0; /* 调整margin */
							padding: 10px; /* 调整padding */
							box-sizing: border-box;
							border: 1px solid #ccc;
							border-radius: 4px;
							font-size: 13px;
							line-height: 1.5;
							overflow-y: auto;
							resize: none;
						}
						.save-container {
							margin-top: 8px; /* 调整margin */
							display: flex;
							align-items: center;
							gap: 10px; /* 调整gap */
						}
						.save-btn, .back-btn {
							padding: 6px 15px; /* 调整padding */
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
						}
						.save-btn {
							background: #4CAF50;
						}
						.save-btn:hover {
							background: #45a049;
						}
						.back-btn {
							background: #666;
						}
						.back-btn:hover {
							background: #555;
						}
						.save-status {
							color: #666;
						}
					</style>
					<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
				</head>
				<body>
					################################################################<br>
					Subscribe / sub 订阅地址, 点击链接自动 <strong>复制订阅链接</strong> 并 <strong>生成订阅二维码</strong> <br>
					---------------------------------------------------------------<br>
					自适应订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/${mytoken}?sub','qrcode_0')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/${mytoken}</a><br>
					<div id="qrcode_0" style="margin: 10px 10px 10px 10px;"></div>
					Base64订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/${mytoken}?b64','qrcode_1')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/${mytoken}?b64</a><br>
					<div id="qrcode_1" style="margin: 10px 10px 10px 10px;"></div>
					clash订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/${mytoken}?clash','qrcode_2')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/${mytoken}?clash</a><br>
					<div id="qrcode_2" style="margin: 10px 10px 10px 10px;"></div>
					singbox订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/${mytoken}?sb','qrcode_3')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/${mytoken}?sb</a><br>
					<div id="qrcode_3" style="margin: 10px 10px 10px 10px;"></div>
					surge订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/${mytoken}?surge','qrcode_4')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/${mytoken}?surge</a><br>
					<div id="qrcode_4" style="margin: 10px 10px 10px 10px;"></div>
					loon订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/${mytoken}?loon','qrcode_5')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/${mytoken}?loon</a><br>
					<div id="qrcode_5" style="margin: 10px 10px 10px 10px;"></div>
					&nbsp;&nbsp;<strong><a href="javascript:void(0);" id="noticeToggle" onclick="toggleNotice()">查看访客订阅∨</a></strong><br>
					<div id="noticeContent" class="notice-content" style="display: none;">
						---------------------------------------------------------------<br>
						访客订阅只能使用订阅功能，无法查看配置页！<br>
						GUEST（访客订阅TOKEN）: <strong>${guest}</strong><br>
						---------------------------------------------------------------<br>
						自适应订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${guest}','guest_0')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${guest}</a><br>
						<div id="guest_0" style="margin: 10px 10px 10px 10px;"></div>
						Base64订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${guest}&b64','guest_1')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${guest}&b64</a><br>
						<div id="guest_1" style="margin: 10px 10px 10px 10px;"></div>
						clash订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${guest}&clash','guest_2')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${guest}&clash</a><br>
						<div id="guest_2" style="margin: 10px 10px 10px 10px;"></div>
						singbox订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${guest}&sb','guest_3')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${guest}&sb</a><br>
						<div id="guest_3" style="margin: 10px 10px 10px 10px;"></div>
						surge订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${guest}&surge','guest_4')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${guest}&surge</a><br>
						<div id="guest_4" style="margin: 10px 10px 10px 10px;"></div>
						loon订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${guest}&loon','guest_5')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${guest}&loon</a><br>
						<div id="guest_5" style="margin: 10px 10px 10px 10px;"></div>
					</div>
					---------------------------------------------------------------<br>
					################################################################<br>
					订阅转换配置<br>
					---------------------------------------------------------------<br>
					SUBAPI（订阅转换后端）: <strong>${subConverterDisplay}</strong><br>
					<!-- SUBAPI STRATEGY: <strong>${SUB_CONVERTER_STRATEGY}</strong><br> -->
					<!-- SUBAPI STATE: <strong>${subConverterStateBackend}</strong><br> -->
					SUBCONFIG（订阅转换配置文件）: <strong>${subConfig}</strong><br>
					<!-- SUBRETRY: <strong>${subRetry}</strong> / SUBTIMEOUT: <strong>${subTimeout}ms</strong><br> -->
					<!-- SUBAPITIMEOUT: <strong>${subApiTimeout}ms</strong> / SUBAPISTAGGER: <strong>${subApiStagger}ms</strong><br> -->
					<!-- SUBCACHE: <strong>${subCache}s</strong><br> -->
					<!-- SHOW_FAILED_SUB: <strong>${showFailedSub ? '1' : '0'}</strong><br> -->
					VERSION（部署标记）: <strong>${CUSTOM_FIX_VERSION}</strong><br>
					---------------------------------------------------------------<br>
					################################################################<br>
					${FileName} 汇聚订阅编辑:
					<br>数据统计: <strong>${stats.total}</strong> 行 / 自建节点 <strong>${stats.local}</strong> / 远程订阅 <strong>${stats.remote}</strong><br>
					<div class="editor-container">
						${hasKV ? `
						<textarea class="editor" 
							placeholder="${decodeURIComponent(atob('TElOSyVFNyVBNCVCQSVFNCVCRSU4QiVFRiVCQyU4OCVFNCVCOCU4MCVFOCVBMSU4QyVFNCVCOCU4MCVFNCVCOCVBQSVFOCU4QSU4MiVFNyU4MiVCOSVFOSU5MyVCRSVFNiU4RSVBNSVFNSU4RCVCMyVFNSU4RiVBRiVFRiVCQyU4OSVFRiVCQyU5QQp2bGVzcyUzQSUyRiUyRjI0NmFhNzk1LTA2MzctNGY0Yy04ZjY0LTJjOGZiMjRjMWJhZCU0MDEyNy4wLjAuMSUzQTEyMzQlM0ZlbmNyeXB0aW9uJTNEbm9uZSUyNnNlY3VyaXR5JTNEdGxzJTI2c25pJTNEVEcuQ01MaXVzc3NzLmxvc2V5b3VyaXAuY29tJTI2YWxsb3dJbnNlY3VyZSUzRDElMjZ0eXBlJTNEd3MlMjZob3N0JTNEVEcuQ01MaXVzc3NzLmxvc2V5b3VyaXAuY29tJTI2cGF0aCUzRCUyNTJGJTI1M0ZlZCUyNTNEMjU2MCUyM0NGbmF0CnRyb2phbiUzQSUyRiUyRmFhNmRkZDJmLWQxY2YtNGE1Mi1iYTFiLTI2NDBjNDFhNzg1NiU0MDIxOC4xOTAuMjMwLjIwNyUzQTQxMjg4JTNGc2VjdXJpdHklM0R0bHMlMjZzbmklM0RoazEyLmJpbGliaWxpLmNvbSUyNmFsbG93SW5zZWN1cmUlM0QxJTI2dHlwZSUzRHRjcCUyNmhlYWRlclR5cGUlM0Rub25lJTIzSEsKc3MlM0ElMkYlMkZZMmhoWTJoaE1qQXRhV1YwWmkxd2IyeDVNVE13TlRveVJYUlFjVzQyU0ZscVZVNWpTRzlvVEdaVmNFWlJkMjVtYWtORFVUVnRhREZ0U21SRlRVTkNkV04xVjFvNVVERjFaR3RTUzBodVZuaDFielUxYXpGTFdIb3lSbTgyYW5KbmRERTRWelkyYjNCMGVURmxOR0p0TVdwNlprTm1RbUklMjUzRCU0MDg0LjE5LjMxLjYzJTNBNTA4NDElMjNERQoKCiVFOCVBRSVBMiVFOSU5OCU4NSVFOSU5MyVCRSVFNiU4RSVBNSVFNyVBNCVCQSVFNCVCRSU4QiVFRiVCQyU4OCVFNCVCOCU4MCVFOCVBMSU4QyVFNCVCOCU4MCVFNiU5RCVBMSVFOCVBRSVBMiVFOSU5OCU4NSVFOSU5MyVCRSVFNiU4RSVBNSVFNSU4RCVCMyVFNSU4RiVBRiVFRiVCQyU4OSVFRiVCQyU5QQpodHRwcyUzQSUyRiUyRnN1Yi54Zi5mcmVlLmhyJTJGYXV0bw=='))}"
							id="content">${content}</textarea>
						<div class="save-container">
							<button class="save-btn" onclick="saveContent(this)">保存</button>
							<span class="save-status" id="saveStatus"></span>
						</div>
						` : '<p>请绑定 <strong>变量名称</strong> 为 <strong>KV</strong> 的KV命名空间</p>'}
					</div>
					<br>
					################################################################<br>
					${decodeURIComponent(atob('dGVsZWdyYW0lMjAlRTQlQkElQTQlRTYlQjUlODElRTclQkUlQTQlMjAlRTYlOEElODAlRTYlOUMlQUYlRTUlQTQlQTclRTQlQkQlQUMlN0UlRTUlOUMlQTglRTclQkElQkYlRTUlOEYlOTElRTclODklOEMhJTNDYnIlM0UKJTNDYSUyMGhyZWYlM0QlMjdodHRwcyUzQSUyRiUyRnQubWUlMkZDTUxpdXNzc3MlMjclM0VodHRwcyUzQSUyRiUyRnQubWUlMkZDTUxpdXNzc3MlM0MlMkZhJTNFJTNDYnIlM0UKLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tJTNDYnIlM0UKZ2l0aHViJTIwJUU5JUExJUI5JUU3JTlCJUFFJUU1JTlDJUIwJUU1JTlEJTgwJTIwU3RhciFTdGFyIVN0YXIhISElM0NiciUzRQolM0NhJTIwaHJlZiUzRCUyN2h0dHBzJTNBJTJGJTJGZ2l0aHViLmNvbSUyRmNtbGl1JTJGQ0YtV29ya2Vycy1TVUIlMjclM0VodHRwcyUzQSUyRiUyRmdpdGh1Yi5jb20lMkZjbWxpdSUyRkNGLVdvcmtlcnMtU1VCJTNDJTJGYSUzRSUzQ2JyJTNFCi0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSUzQ2JyJTNFCiUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMyUyMw=='))}
					<br>Modified by <strong>FisheeHei</strong><br>
					custom-fix repo: <a href="https://github.com/FisheeHei/CF-Workers-SUB" target="_blank" rel="noopener noreferrer">https://github.com/FisheeHei/CF-Workers-SUB</a><br>
					----------------------------------------------------------------<br>
					################################################################<br>
					<br><br>UA: <strong>${request.headers.get('User-Agent')}</strong>
					<script>
					function copyToClipboard(text, qrcode) {
						navigator.clipboard.writeText(text).then(() => {
							alert('已复制到剪贴板');
						}).catch(err => {
							console.error('复制失败:', err);
						});
						const qrcodeDiv = document.getElementById(qrcode);
						qrcodeDiv.innerHTML = '';
						new QRCode(qrcodeDiv, {
							text: text,
							width: 220, // 调整宽度
							height: 220, // 调整高度
							colorDark: "#000000", // 二维码颜色
							colorLight: "#ffffff", // 背景颜色
							correctLevel: QRCode.CorrectLevel.Q, // 设置纠错级别
							scale: 1 // 调整像素颗粒度
						});
					}
						
					if (document.querySelector('.editor')) {
						let timer;
						const textarea = document.getElementById('content');
						const originalContent = textarea.value;
		
						function goBack() {
							const currentUrl = window.location.href;
							const parentUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/'));
							window.location.href = parentUrl;
						}
		
						function replaceFullwidthColon() {
							const text = textarea.value;
							textarea.value = text.replace(/：/g, ':');
						}
						
						function saveContent(button) {
							try {
								const updateButtonText = (step) => {
									button.textContent = \`保存中: \${step}\`;
								};
								// 检测是否为iOS设备
								const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
								
								// 仅在非iOS设备上执行replaceFullwidthColon
								if (!isIOS) {
									replaceFullwidthColon();
								}
								updateButtonText('开始保存');
								button.disabled = true;

								// 获取textarea内容和原始内容
								const textarea = document.getElementById('content');
								if (!textarea) {
									throw new Error('找不到文本编辑区域');
								}

								updateButtonText('获取内容');
								let newContent;
								let originalContent;
								try {
									newContent = textarea.value || '';
									originalContent = textarea.defaultValue || '';
								} catch (e) {
									console.error('获取内容错误:', e);
									throw new Error('无法获取编辑内容');
								}

								updateButtonText('准备状态更新函数');
								const updateStatus = (message, isError = false) => {
									const statusElem = document.getElementById('saveStatus');
									if (statusElem) {
										statusElem.textContent = message;
										statusElem.style.color = isError ? 'red' : '#666';
									}
								};

								updateButtonText('准备按钮重置函数');
								const resetButton = () => {
									button.textContent = '保存';
									button.disabled = false;
								};

								if (newContent !== originalContent) {
									updateButtonText('发送保存请求');
									fetch(window.location.href, {
										method: 'POST',
										body: newContent,
										headers: {
											'Content-Type': 'text/plain;charset=UTF-8'
										},
										cache: 'no-cache'
									})
									.then(response => {
										updateButtonText('检查响应状态');
										if (!response.ok) {
											throw new Error(\`HTTP error! status: \${response.status}\`);
										}
										updateButtonText('更新保存状态');
										const now = new Date().toLocaleString();
										document.title = \`编辑已保存 \${now}\`;
										textarea.defaultValue = newContent;
										updateStatus(\`已保存 \${now}\`);
									})
									.catch(error => {
										updateButtonText('处理错误');
										console.error('Save error:', error);
										updateStatus(\`保存失败: \${error.message}\`, true);
									})
									.finally(() => {
										resetButton();
									});
								} else {
									updateButtonText('检查内容变化');
									updateStatus('内容未变化');
									resetButton();
								}
							} catch (error) {
								console.error('保存过程出错:', error);
								button.textContent = '保存';
								button.disabled = false;
								const statusElem = document.getElementById('saveStatus');
								if (statusElem) {
									statusElem.textContent = \`错误: \${error.message}\`;
									statusElem.style.color = 'red';
								}
							}
						}
		
						textarea.addEventListener('blur', () => saveContent(document.querySelector('.save-btn')));
						textarea.addEventListener('input', () => {
							clearTimeout(timer);
							timer = setTimeout(() => saveContent(document.querySelector('.save-btn')), 5000);
						});
					}

					function toggleNotice() {
						const noticeContent = document.getElementById('noticeContent');
						const noticeToggle = document.getElementById('noticeToggle');
						if (noticeContent.style.display === 'none' || noticeContent.style.display === '') {
							noticeContent.style.display = 'block';
							noticeToggle.textContent = '隐藏访客订阅∧';
						} else {
							noticeContent.style.display = 'none';
							noticeToggle.textContent = '查看访客订阅∨';
						}
					}
			
					// 初始化 noticeContent 的 display 属性
					document.addEventListener('DOMContentLoaded', () => {
						document.getElementById('noticeContent').style.display = 'none';
					});
					</script>
				</body>
			</html>
		`;

		return new Response(html, {
			headers: runtimeHeaders({ "Content-Type": "text/html;charset=utf-8" })
		});
	} catch (error) {
		console.error('处理请求时发生错误:', error);
		return new Response("服务器错误: " + error.message, {
			status: 500,
			headers: runtimeHeaders({ "Content-Type": "text/plain;charset=utf-8" })
		});
	}
}
