const fs = require('fs');
const https = require('https');

// 读取环境变量并去除首尾空格
const RAW_REFRESH_TOKEN = process.env.REFRESH_TOKEN || "";
const REFRESH_TOKEN = RAW_REFRESH_TOKEN.trim();
const BARK_URL_PREFIX = process.env.BARK_DOMAIN;
const CACHE_PATH = './status_cache.json';

const HEADERS = {
  "Host": "ldcx.huandian.shop",
  "Connection": "keep-alive",
  "content-type": "application/json;charset=utf-8",
  "Accept-Encoding": "gzip,compress,br,deflate",
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b2f) NetType/WIFI Language/zh_CN",
  "Referer": "https://servicewechat.com/wxf6e2c5518bf31de0/23/page-frame.html"
};

// 读取缓存状态
function loadCache() {
  try {
    const text = fs.readFileSync(CACHE_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return { notified: false };
  }
}

// 写入缓存
function saveCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// GET 请求
function getReq(url, headers) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers }, resp => {
      let buf = '';
      resp.on('data', d => buf += d);
      resp.on('end', () => res({ code: resp.statusCode, body: buf }));
    });
    req.on('error', e => rej(`网络请求异常: ${e.message}`));
    req.end();
  });
}

// POST 请求
function postReq(url, headers, bodyObj) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(bodyObj);
    const opt = {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(url, opt, resp => {
      let buf = '';
      resp.on('data', d => buf += d);
      resp.on('end', () => res({ code: resp.statusCode, body: buf }));
    });
    req.on('error', e => rej(`网络请求异常: ${e.message}`));
    req.write(body);
    req.end();
  });
}

// Bark推送
async function sendNotify(soc) {
  const title = encodeURIComponent('铁塔电量');
  const content = encodeURIComponent(`电量剩余${soc}%`);
  const barkFull = `${BARK_URL_PREFIX}/${title}/${content}`;
  await getReq(barkFull, {});
  console.log('✅ 已发送低电量通知');
}

async function run() {
  const cache = loadCache();
  console.log('当前缓存状态:', cache);
  console.log("传入的RefreshToken长度:", REFRESH_TOKEN.length);

  // 1. 刷新 accessToken
  const refreshUrl = `https://ldcx.huandian.shop/wf/refresh/token?refreshToken=${REFRESH_TOKEN}`;
  console.log("开始请求刷新Token接口:", refreshUrl);
  const refreshRes = await getReq(refreshUrl, HEADERS);
  console.log("刷新接口HTTP状态码:", refreshRes.code);
  console.log("刷新接口完整返回数据:", refreshRes.body);

  // 解析返回
  let refreshData;
  try {
    refreshData = JSON.parse(refreshRes.body);
  } catch (e) {
    throw new Error(`刷新接口返回非JSON，原始内容：${refreshRes.body}`);
  }

  if (refreshData.code !== 0 || !refreshData.data?.token) {
    throw new Error(`接口返回异常 code=${refreshData.code}，完整返回：${JSON.stringify(refreshData)}`);
  }
  const accessToken = refreshData.data.token;
  console.log("✅ 获取临时accessToken成功");

  // 2. 获取SN列表
  const userHeaders = { ...HEADERS, token: accessToken };
  const userRes = await getReq('https://ldcx.huandian.shop/app/user/usage', userHeaders);
  const userData = JSON.parse(userRes.body);
  const snList = userData.data.multi_mode_bind_battery;
  if (!snList?.length) throw new Error('未查询到绑定电池SN列表');

  // 3. 获取电量
  const batRes = await postReq(
    'https://ldcx.huandian.shop/app/user/bindBattery/status',
    userHeaders,
    { batterySnList: snList }
  );
  const batData = JSON.parse(batRes.body);
  const soc = batData.data[0].batSoc;
  console.log(`实时电量: ${soc}%`);

  // 推送逻辑：≤50 只通知一次，回升后重置
  if (soc <= 50) {
    if (!cache.notified) {
      await sendNotify(soc);
      cache.notified = true;
      saveCache(cache);
    } else {
      console.log('电量依旧低于50%，已推送过通知，跳过本次推送');
    }
  } else {
    if (cache.notified) {
      cache.notified = false;
      saveCache(cache);
      console.log('电量恢复至50%以上，清除低电量通知标记');
    } else {
      console.log('电量充足，无需操作');
    }
  }
}

run().catch(err => {
  console.error('❌ 执行失败完整错误信息:', err.message);
  process.exit(1);
});
