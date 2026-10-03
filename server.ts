// 网易云多人一起听 - 未登录跟踪服务
// 启动: deno task start

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const WS_PORT = Number(Deno.env.get("WS_PORT") ?? 8888);
const POLL_MS = Number(Deno.env.get("POLL_MS") ?? 8000);
const DEAD_THRESHOLD = 3;        // 连续 N 次失败判房间死亡
const CLEANUP_AFTER_MS = 5 * 60 * 1000;  // 死亡后多久清理

// ---------- weapi 加密 ----------
const AES_KEY = new TextEncoder().encode("0CoJUm6Qyw8W8jud");
const IV = new TextEncoder().encode("0102030405060708");
const PUB_E = 0x10001n;
const PUB_N = BigInt("0x" +
"00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725" +
"152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e03" +
"12ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10" +
"b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462d" +
"b0a22b8e7");

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function aesEncrypt(text: string, key: Uint8Array): Promise<string> {
  const keyObj = await crypto.subtle.importKey(
    "raw", key, { name: "AES-CBC" }, false, ["encrypt"],
  );
  const data = new TextEncoder().encode(text);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV }, keyObj, data);
  return b64(new Uint8Array(ct));
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function rsaEncrypt(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const reversed = new Uint8Array(bytes).reverse();
  let hex = "";
  for (const b of reversed) hex += b.toString(16).padStart(2, "0");
  const m = hex.length ? BigInt("0x" + hex) : 0n;
  return modPow(m, PUB_E, PUB_N).toString(16).padStart(256, "0");
}

function randSecretKey(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

async function weapi(obj: unknown) {
  const sk = randSecretKey();
  const skBytes = new TextEncoder().encode(sk);
  const p1 = await aesEncrypt(JSON.stringify(obj), AES_KEY);
  const p2 = await aesEncrypt(p1, skBytes);
  return { params: p2, encSecKey: rsaEncrypt(sk) };
}

// ---------- 分享链接解析 ----------
function parseShare(text: string): { roomId: string; inviterUid: string } | null {
  text = text.trim();
  if (!text) return null;
  if (/^[0-9a-f]{32}_\d+$/i.test(text)) {
    return { roomId: text, inviterUid: "288268482" };
  }
  try {
    const url = new URL(
      text.startsWith("http")
      ? text
      : "https://st.music.163.com/listen-together/multishare/index.html?" + text,
    );
    const q = url.searchParams;
    const roomId = q.get("roomId") || q.get("room_id") || q.get("rid");
    const inviterUid = q.get("inviterUid") || q.get("inviter_uid") ||
    q.get("inviterId") || q.get("creatorId") || "288268482";
    if (!roomId) return null;
    return { roomId, inviterUid };
  } catch {
    return null;
  }
}

// ---------- 上游请求 ----------
async function fetchRoom(roomId: string, inviterUid: string) {
  const body = await weapi({ roomId, inviterUid });
  const res = await fetch(
    "https://interface.music.163.com/weapi/listen/together/multi/landing/info/get",
    {
      method: "POST",
      headers: {
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
                          "Referer": "https://st.music.163.com/",
                          "Content-Type": "application/x-www-form-urlencoded",
                          "Cookie":
                          "deviceId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee; os=pc; appver=9.5.70",
      },
      body: new URLSearchParams(body),
    },
  );
  return await res.json();
}

// ---------- 房间跟踪 ----------
type Member = {
  uid: number;
  nickname: string;
  avatar: string;
  isInviter: boolean;
};

type HistoryEntry = {
  songId: number;
  name: string;
  artists: string;
  cover: string;
  startedAt: number;
  playedSec: number;
  durationSec: number;
  complete: boolean;
};

type RoomState = {
  roomId: string;
  inviterUid: string;
  songId: number | null;
  name: string;
  artists: string;
  cover: string;
  durationMs: number;
  firstSeenAt: number;
  lastPollAt: number;
  lastUpdatedAt: number;
  status: "tracking" | "dead";
  deadAt: number | null;
  failureCount: number;
  history: HistoryEntry[];
  members: Member[];
  timer: number | null;
  addedAt: number;
};

const rooms = new Map<string, RoomState>();

// roomId -> 已订阅的 WS 连接
const subscribers = new Map<string, Set<WebSocket>>();

function broadcast(roomId: string) {
  const subs = subscribers.get(roomId);
  if (!subs || subs.size === 0) return;
  const s = rooms.get(roomId);
  if (!s) return;
  const msg = JSON.stringify({ type: "snapshot", data: snapshot(s) });
  for (const ws of subs) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    } catch { /* ignore */ }
  }
}

function finalizeCurrent(s: RoomState) {
  if (s.songId == null) return;
  const elapsed = Date.now() - s.firstSeenAt;
  s.history.push({
    songId: s.songId,
    name: s.name,
    artists: s.artists,
    cover: s.cover,
    startedAt: s.firstSeenAt,
    playedSec: Math.round(Math.min(elapsed, s.durationMs) / 1000),
                 durationSec: Math.round(s.durationMs / 1000),
                 complete: elapsed >= s.durationMs - POLL_MS,
  });
  if (s.history.length > 100) s.history.shift();
}

function applySong(s: RoomState, song: any) {
  const now = Date.now();
  const sid = Number(song?.id ?? 0);
  if (!sid) return;
  const duration = Number(song?.duration ?? 0);

  if (sid !== s.songId) {
    finalizeCurrent(s);
    s.songId = sid;
    s.firstSeenAt = now;
    s.durationMs = duration;
    s.name = song?.name ?? "";
    s.artists = (song?.artists ?? []).map((a: any) => a?.name ?? "").join("/");
    s.cover = song?.album?.picUrl ?? "";
  } else if (duration && duration !== s.durationMs) {
    s.durationMs = duration;
  }
  s.lastUpdatedAt = now;
  s.failureCount = 0;
}

function updateMembers(s: RoomState, data: any) {
  const list: Member[] = [];
  if (data?.inviter) {
    list.push({
      uid: Number(data.inviter.uid ?? 0),
              nickname: String(data.inviter.nickname ?? ""),
              avatar: String(data.inviter.avatar ?? ""),
              isInviter: true,
    });
  }
  for (const o of data?.others ?? []) {
    list.push({
      uid: Number(o?.uid ?? 0),
              nickname: String(o?.nickname ?? ""),
              avatar: String(o?.avatar ?? ""),
              isInviter: false,
    });
  }
  s.members = list;
}

function markDead(s: RoomState, reason: string) {
  if (s.status === "dead") return;
  finalizeCurrent(s);
  s.status = "dead";
  s.deadAt = Date.now();
  if (s.timer != null) {
    clearInterval(s.timer);
    s.timer = null;
  }
  console.log(`[dead] ${s.roomId} (${reason})`);
}

async function pollOnce(s: RoomState) {
  s.lastPollAt = Date.now();
  try {
    const res = await fetchRoom(s.roomId, s.inviterUid);
    if (res?.code === 200 && res?.data) {
      const data = res.data;
      updateMembers(s, data);
      if (data.roomStatus && data.roomStatus !== "AVAILABLE") {
        markDead(s, `roomStatus=${data.roomStatus}`);
        broadcast(s.roomId);
        return;
      }
      if (data.songData) applySong(s, data.songData);
      s.failureCount = 0;
      broadcast(s.roomId);
      return;
    }
    // 明确失效
    if (res?.code === 488 || res?.code === 301 || res?.code === 404) {
      markDead(s, `code=${res.code}`);
      broadcast(s.roomId);
      return;
    }
    s.failureCount++;
    if (s.failureCount >= DEAD_THRESHOLD) {
      markDead(s, `连续 ${s.failureCount} 次失败 code=${res?.code}`);
    }
    broadcast(s.roomId);
  } catch (e) {
    s.failureCount++;
    if (s.failureCount >= DEAD_THRESHOLD) {
      markDead(s, `网络错误: ${(e as Error).message}`);
    }
    broadcast(s.roomId);
  }
}

function startTracking(roomId: string, inviterUid: string): RoomState {
  let s = rooms.get(roomId);
  if (s && s.status === "tracking") return s;
  if (s) {
    // 复活：清掉旧的
    if (s.timer != null) clearInterval(s.timer);
    rooms.delete(roomId);
  }
  s = {
    roomId,
    inviterUid,
    songId: null,
    name: "",
    artists: "",
    cover: "",
    durationMs: 0,
    firstSeenAt: 0,
    lastPollAt: 0,
    lastUpdatedAt: 0,
    status: "tracking",
    deadAt: null,
    failureCount: 0,
    history: [],
    members: [],
    timer: null,
    addedAt: Date.now(),
  };
  rooms.set(roomId, s);
  // 立即拉一次
  pollOnce(s);
  s.timer = setInterval(() => pollOnce(s), POLL_MS) as unknown as number;
  console.log(`[start] ${roomId} inviterUid=${inviterUid} interval=${POLL_MS}ms`);
  return s;
}

// 清理：死亡且超过 CLEANUP_AFTER_MS 的房间
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of rooms) {
    if (s.status === "dead" && s.deadAt && now - s.deadAt > CLEANUP_AFTER_MS) {
      rooms.delete(id);
      console.log(`[cleanup] ${id}`);
    }
  }
}, 60_000);

// ---------- HTTP 工具 ----------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function snapshot(s: RoomState) {
  const now = Date.now();
  const progressMs = s.songId != null
  ? Math.min(now - s.firstSeenAt, s.durationMs)
  : 0;
  const remainingMs = s.durationMs > 0
  ? Math.max(0, s.durationMs - progressMs)
  : 0;
  return {
    roomId: s.roomId,
    status: s.status,
    song: s.songId != null
    ? {
      id: s.songId,
      name: s.name,
      artists: s.artists,
      cover: s.cover,
      durationMs: s.durationMs,
    }
    : null,
    progressMs,
    remainingMs,
    firstSeenAt: s.firstSeenAt,
    lastUpdatedAt: s.lastUpdatedAt,
    pollIntervalMs: POLL_MS,
    accuracyMs: POLL_MS,
    members: s.members,
    history: s.history.slice(-20),
  };
}

// ---------- 歌曲 URL ----------
async function fetchSongUrl(songId: number) {
  const body = await weapi({
    ids: JSON.stringify([songId]),
                           br: 320000,
  });
  const res = await fetch(
    "https://interface.music.163.com/weapi/song/enhance/player/url",
    {
      method: "POST",
      headers: {
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
                          "Referer": "https://music.163.com/",
                          "Content-Type": "application/x-www-form-urlencoded",
                          "Cookie":
                          "deviceId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee; os=pc; appver=9.5.70",
      },
      body: new URLSearchParams(body),
    },
  );
  return await res.json();
}

// ---------- WebSocket 服务器（独立端口） ----------
Deno.serve({ port: WS_PORT }, (req) => {
  const url = new URL(req.url);
  if (url.pathname !== "/ws") {
    return new Response("Not Found", { status: 404 });
  }
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 400 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const myRooms = new Set<string>();

  socket.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (msg?.type === "subscribe" && typeof msg.roomId === "string") {
      const rid = msg.roomId;
      myRooms.add(rid);
      let set = subscribers.get(rid);
      if (!set) {
        set = new Set();
        subscribers.set(rid, set);
      }
      set.add(socket);
      // 订阅时立刻推一次当前快照
      const s = rooms.get(rid);
      if (s) {
        try {
          socket.send(JSON.stringify({ type: "snapshot", data: snapshot(s) }));
        } catch { /* ignore */ }
      }
    } else if (msg?.type === "unsubscribe" && typeof msg.roomId === "string") {
      myRooms.delete(msg.roomId);
      subscribers.get(msg.roomId)?.delete(socket);
    }
  };

  socket.onclose = () => {
    for (const rid of myRooms) {
      subscribers.get(rid)?.delete(socket);
    }
    myRooms.clear();
  };

  return response;
});

// ---------- 主 HTTP 服务器 ----------
Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // 静态首页
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      let html = await Deno.readTextFile(
        new URL("./public/index.html", import.meta.url),
      );
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      return new Response("index.html 读取失败: " + e, { status: 500 });
    }
  }

  // 加入跟踪
  if (url.pathname === "/api/room" && req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid-json" }, 400); }
    const parsed = parseShare(String(body?.input ?? ""));
    if (!parsed) return json({ error: "无法解析 roomId" }, 400);
    const s = startTracking(parsed.roomId, parsed.inviterUid);
    return json(snapshot(s));
  }

  // 查询（保留兼容，但前端不再轮询）
  const m = url.pathname.match(/^\/api\/room\/([^/]+)\/now$/);
  if (m) {
    const roomId = decodeURIComponent(m[1]);
    const s = rooms.get(roomId);
    if (!s) return json({ error: "not-tracking" }, 404);
    return json(snapshot(s));
  }

  // 手动同步（强制立即拉一次上游）
  const syncMatch = url.pathname.match(/^\/api\/room\/([^/]+)\/sync$/);
  if (syncMatch && req.method === "POST") {
    const roomId = decodeURIComponent(syncMatch[1]);
    const s = rooms.get(roomId);
    if (!s) return json({ error: "not-tracking" }, 404);
    await pollOnce(s);
    return json(snapshot(s));
  }

  // 列表
  if (url.pathname === "/api/rooms") {
    return json(Array.from(rooms.values()).map(snapshot));
  }

  // 停止跟踪（保留 API 兼容，前端已不暴露）
  if (url.pathname.startsWith("/api/room/") && req.method === "DELETE") {
    const roomId = decodeURIComponent(url.pathname.slice("/api/room/".length));
    const s = rooms.get(roomId);
    if (!s) return json({ error: "not-tracking" }, 404);
    if (s.timer != null) clearInterval(s.timer);
    rooms.delete(roomId);
    return json({ ok: true });
  }

  // 歌曲播放 URL
  const songMatch = url.pathname.match(/^\/api\/song\/(\d+)\/url$/);
  if (songMatch) {
    const id = Number(songMatch[1]);
    try {
      const data = await fetchSongUrl(id);
      const track = data?.data?.[0];
      const playUrl = track?.url ?? null;
      return json({
        songId: id,
        url: playUrl,
        br: track?.br ?? 0,
        size: track?.size ?? 0,
        code: data?.code ?? 0,
      });
    } catch (e) {
      return json({ songId: id, url: null, error: (e as Error).message }, 500);
    }
  }

  return new Response("Not Found", { status: 404 });
});

console.log(`✅ 一起听跟踪服务: http://localhost:${PORT}`);
console.log(`🔌 WebSocket 推送: ws://localhost:${WS_PORT}/ws`);
console.log(`   轮询间隔: ${POLL_MS}ms  (精度约 ±${POLL_MS}ms)`);
