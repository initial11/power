const fs = require('fs');
const https = require('https');

// ====================== 配置（无需修改，变量从仓库Secrets读取） ======================
const LONG_REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BARK_BASE = process.env.BARK_URL; // 格式: https://xxx.bark.app
const CACHE_FILE = "./status_cache.json";
// ==============================================================================

// 接口固定请求头（和你之前JS/PHP/安卓完全统一）
const baseHeaders = {
    "Host": "ldcx.huandian.shop",
    "Connection": "keep-alive",
    "content-type": "application/json;charset=utf-8",
    "Accept-Encoding": "gzip,compress,br,deflate",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b2f) NetType/WIFI Language/zh_CN",
    "Referer": "https://servicewechat.com/wxf6e2c5518bf31de0/23/page-frame.html"
};

// 读取本地缓存：记录上一轮是否已经推送过低电量通知
function loadCache() {
    try {
        const raw = fs.readFileSync(CACHE_FILE, "utf8");
        return JSON.parse(raw);
    } catch (e) {
        // 文件不存在则初始化：has_notified=false 代表未推送过低电量
        return { has_notified: false };
    }
}

// 写入缓存状态
function saveCache(data) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
}

// HTTPS通用GET请求封装
function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, res => {
            let buf = "";
            res.on("data", d => buf += d);
            res.on("end", () => resolve({ code: res.statusCode, body: buf }));
        });
        req.on("error", err => reject(err));
        req.end();
    });
}

// HTTPS通用POST请求封装
function httpPost(url, headers, bodyObj) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(bodyObj);
        const opt = {
            method: "POST",
            headers: { ...headers, "Content-Length": Buffer.byteLength(body) }
        };
        const req = https.request(url, opt, res => {
            let buf = "";
            res.on("data", d => buf += d);
            res.on("end", () => resolve({ code: res.statusCode, body: buf }));
        });
        req.on("error", err => reject(err));
        req.write(body);
        req.end();
    });
}

// Bark推送通知
async function sendBark(soc) {
    const title = encodeURIComponent("铁塔电量");
    const content = encodeURIComponent(`电量剩余${soc}%`);
    const barkUrl = `${BARK_BASE}/${title}/${content}`;
    await httpGet(barkUrl, {});
    console.log("✅ Bark低电量通知已推送");
}

// 主逻辑：刷新token→获取SN→获取电量→判断推送
async function main() {
    const cache = loadCache();
    console.log("本地缓存状态", cache);

    // 1. GET 刷新临时accessToken
    const refreshUrl = `https://ldcx.huandian.shop/wf/refresh/token?refreshToken=${LONG_REFRESH_TOKEN}`;
    const refreshRes = await httpGet(refreshUrl, baseHeaders);
    if (refreshRes.code !== 200) throw new Error("刷新Token接口请求失败");
    const refreshData = JSON.parse(refreshRes.body);
    if (refreshData.code !== 0 || !refreshData.data?.token) throw new Error("RefreshToken失效，请重新抓包");
    const accessToken = refreshData.data.token;

    // 2. GET 用户信息获取电池SN列表
    const userUrl = "https://ldcx.huandian.shop/app/user/usage";
    const userHeaders = { ...baseHeaders, token: accessToken };
    const userRes = await httpGet(userUrl, userHeaders);
    const userData = JSON.parse(userRes.body);
    if (userData.code !== 0 || !userData.data?.multi_mode_bind_battery?.length) throw new Error("未查询到绑定电池");
    const snList = userData.data.multi_mode_bind_battery;

    // 3. POST 查询电池实时状态
    const batUrl = "https://ldcx.huandian.shop/app/user/bindBattery/status";
    const batHeaders = { ...baseHeaders, token: accessToken };
    const batRes = await httpPost(batUrl, batHeaders, { batterySnList: snList });
    const batData = JSON.parse(batRes.body);
    if (batData.code !== 0 || !batData.data?.length) throw new Error("无电池实时数据");
    const soc = batData.data[0].batSoc;
    console.log(`当前电量：${soc}%`);

    // 核心判断规则
    if (soc <= 50) {
        if (!cache.has_notified) {
            // 电量≤50 且本轮未推送过 → 推送通知，标记已通知
            await sendBark(soc);
            cache.has_notified = true;
            saveCache(cache);
        } else {
            console.log("⚠️ 电量依旧低于50，但已推送过通知，跳过");
        }
    } else {
        // 电量恢复50以上，重置标记，下次低电量可以再次推送
        if (cache.has_notified) {
            cache.has_notified = false;
            saveCache(cache);
            console.log("✅ 电量恢复至50%以上，清除低电量通知标记");
        } else {
            console.log("电量充足，无需操作");
        }
    }
}

// 执行捕获异常
main().catch(err => {
    console.error("❌ 执行失败：", err.message);
    process.exit(1);
});
