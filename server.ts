// 网易云多人一起听 - 未登录跟踪服务
// 启动: deno task start
// 登录：MUSIC_U=xxx deno task start
//   或  COOKIE="MUSIC_U=xxx; __csrf=yyy" deno task start

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const WS_PORT = Number(Deno.env.get("WS_PORT") ?? 8888);
const POLL_MS = Number(Deno.env.get("POLL_MS") ?? 4000);
const SONG_BR = Number(Deno.env.get("SONG_BR") ?? 320000);   // 音质：320000 / 999000(无损)
const DEAD_THRESHOLD = 3;
const HEARTBEAT_TIMEOUT_MS = POLL_MS * 6;
const CLEANUP_AFTER_MS = 5 * 60 * 1000;

// ---------- Cookie / 认证 ----------
const DEFAULT_BASE_COOKIE =
  "deviceId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee; os=pc; appver=9.5.70";

function composeCookieFromMusicU(musicU: string): string {
  if (!musicU) return DEFAULT_BASE_COOKIE;
  return `MUSIC_U=${musicU}; ${DEFAULT_BASE_COOKIE}`;
}

// 优先级：COOKIE 环境变量 > MUSIC_U 环境变量 > 匿名 cookie
let COOKIE: string = (() => {
  const raw = Deno.env.get("COOKIE");
  if (raw && raw.trim()) return raw.trim();
  const mu = Deno.env.get("MUSIC_U");
  if (mu && mu.trim()) return composeCookieFromMusicU(mu.trim());
  return DEFAULT_BASE_COOKIE;
})();

function isAuthed(): boolean {
  // 有非空的 MUSIC_U=xxx 才算登录
  return /(^|;\s*)MUSIC_U=[^;\s]/.test(COOKIE);
}

function setAuth(opts: { musicU?: string; cookie?: string }) {
  if (typeof opts.cookie === "string" && opts.cookie.trim()) {
    COOKIE = opts.cookie.trim();
    return;
  }
  if (typeof opts.musicU === "string") {
    COOKIE = composeCookieFromMusicU(opts.musicU.trim());
  }
}

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
        "Cookie": COOKIE,
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
  lastSuccessAt: number;
  status: "tracking" | "dead";
  deadAt: number | null;
  deadReason: string | null;
  failureCount: number;
  history: HistoryEntry[];
  members: Member[];
  timer: number | null;
  addedAt: number;
};

const rooms = new Map<string, RoomState>();
const subscribers = new Map<string, Set<WebSocket>>();

function roomShareUrl(s: RoomState): string {
  return "https://st.music.163.com/listen-together/multishare/index.html" +
    `?roomId=${encodeURIComponent(s.roomId)}` +
    `&inviterUid=${encodeURIComponent(s.inviterUid)}`;
}

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
  s.deadReason = reason;
  if (s.timer != null) {
    clearInterval(s.timer);
    s.timer = null;
  }
  console.log(`[dead] ${s.roomId} (${reason})`);
}

async function pollOnce(s: RoomState) {
  s.lastPollAt = Date.now();
  if (s.status === "dead") return;

  try {
    const res = await fetchRoom(s.roomId, s.inviterUid);

    if (res?.code === 488 || res?.code === 301 || res?.code === 404) {
      markDead(s, `code=${res.code}`);
      broadcast(s.roomId);
      return;
    }

    if (res?.code === 200 && res?.data) {
      const data = res.data;
      updateMembers(s, data);

      const statusNotOk = data.roomStatus && data.roomStatus !== "AVAILABLE";
      const expireNotOk = typeof data.expire === "number" && data.expire < 0;
      if (statusNotOk || expireNotOk) {
        markDead(
          s,
          `roomStatus=${data.roomStatus ?? "?"} expire=${data.expire ?? "?"}`,
        );
        broadcast(s.roomId);
        return;
      }

      if (data.songData) applySong(s, data.songData);
      s.failureCount = 0;
      s.lastSuccessAt = Date.now();
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
    if (s.timer != null) clearInterval(s.timer);
    rooms.delete(roomId);
  }
  const now = Date.now();
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
    lastSuccessAt: 0,
    status: "tracking",
    deadAt: null,
    deadReason: null,
    failureCount: 0,
    history: [],
    members: [],
    timer: null,
    addedAt: now,
  };
  rooms.set(roomId, s);
  pollOnce(s);
  s.timer = setInterval(() => pollOnce(s), POLL_MS) as unknown as number;
  console.log(`[start] ${roomId} inviterUid=${inviterUid} interval=${POLL_MS}ms`);
  return s;
}

// 清理死亡房间
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of rooms) {
    if (s.status === "dead" && s.deadAt && now - s.deadAt > CLEANUP_AFTER_MS) {
      rooms.delete(id);
      console.log(`[cleanup] ${id}`);
    }
  }
}, 60_000);

// 死亡重播
setInterval(() => {
  for (const [id, s] of rooms) {
    if (s.status === "dead") broadcast(id);
  }
}, 20_000);

// 心跳看门狗
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of rooms) {
    if (s.status !== "tracking") continue;
    const lastOk = s.lastSuccessAt || s.addedAt;
    if (now - lastOk > HEARTBEAT_TIMEOUT_MS) {
      markDead(s, `心跳超时 ${Math.round((now - lastOk) / 1000)}s`);
      broadcast(id);
    }
  }
}, 10_000);

// ---------- 工具 ----------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function emptySnapshot(roomId: string, status = "not-tracking") {
  return {
    roomId,
    status,
    deadAt: Date.now(),
    deadReason: "服务端未跟踪",
    song: null,
    progressMs: 0,
    remainingMs: 0,
    firstSeenAt: 0,
    lastUpdatedAt: 0,
    pollIntervalMs: POLL_MS,
    accuracyMs: POLL_MS,
    members: [],
    history: [],
    shareUrl: null,
  };
}

function snapshot(s: RoomState) {
  const now = Date.now();
  const refTime = s.status === "dead" && s.deadAt ? s.deadAt : now;
  const progressMs = s.songId != null
    ? Math.max(0, Math.min(refTime - s.firstSeenAt, s.durationMs))
    : 0;
  const remainingMs = s.durationMs > 0
    ? Math.max(0, s.durationMs - progressMs)
    : 0;

  return {
    roomId: s.roomId,
    status: s.status,
    deadAt: s.deadAt,
    deadReason: s.deadReason,
    song: s.songId != null
      ? {
        id: s.songId,
        name: s.name,
        artists: s.artists,
        cover: s.cover,
        durationMs: s.durationMs,
        shareUrl: `https://music.163.com/song?id=${s.songId}`,
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
    shareUrl: roomShareUrl(s),
  };
}

// ---------- 歌曲 URL ----------
async function fetchSongUrl(songId: number) {
  const body = await weapi({ ids: JSON.stringify([songId]), br: SONG_BR });
  const res = await fetch(
    "https://interface.music.163.com/weapi/song/enhance/player/url",
    {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Referer": "https://music.163.com/",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": COOKIE,
      },
      body: new URLSearchParams(body),
    },
  );
  return await res.json();
}

// ---------- WebSocket 服务器 ----------
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

      const s = rooms.get(rid);
      const data = s ? snapshot(s) : emptySnapshot(rid);
      try {
        socket.send(JSON.stringify({ type: "snapshot", data }));
      } catch { /* ignore */ }
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

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = await Deno.readTextFile(
        new URL("./public/index.html", import.meta.url),
      );
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      return new Response("index.html 读取失败: " + e, { status: 500 });
    }
  }

  // 登录状态查询
  if (url.pathname === "/api/config" && req.method === "GET") {
    return json({
      authed: isAuthed(),
      br: SONG_BR,
    });
  }

  // 动态设置凭据（无需重启）
  if (url.pathname === "/api/config" && req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid-json" }, 400); }
    const before = isAuthed();
    setAuth({
      musicU: typeof body?.musicU === "string" ? body.musicU : undefined,
      cookie: typeof body?.cookie === "string" ? body.cookie : undefined,
    });
    const after = isAuthed();
    console.log(
      `[auth] 更新登录凭据: ${before ? "已登录" : "未登录"} → ${after ? "已登录" : "未登录"}`,
    );
    return json({ ok: true, authed: after, br: SONG_BR });
  }

  if (url.pathname === "/api/room" && req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid-json" }, 400); }
    const parsed = parseShare(String(body?.input ?? ""));
    if (!parsed) return json({ error: "无法解析 roomId" }, 400);
    const s = startTracking(parsed.roomId, parsed.inviterUid);
    return json(snapshot(s));
  }

  const m = url.pathname.match(/^\/api\/room\/([^/]+)\/now$/);
  if (m) {
    const roomId = decodeURIComponent(m[1]);
    const s = rooms.get(roomId);
    if (!s) return json({ error: "not-tracking" }, 404);
    return json(snapshot(s));
  }

  const syncMatch = url.pathname.match(/^\/api\/room\/([^/]+)\/sync$/);
  if (syncMatch && req.method === "POST") {
    const roomId = decodeURIComponent(syncMatch[1]);
    const s = rooms.get(roomId);
    if (!s) return json({ error: "not-tracking" }, 404);
    await pollOnce(s);
    return json(snapshot(s));
  }

  if (url.pathname === "/api/rooms") {
    return json(
      Array.from(rooms.values())
        .filter((s) => s.status === "tracking")
        .map(snapshot),
    );
  }

  if (url.pathname.startsWith("/api/room/") && req.method === "DELETE") {
    const roomId = decodeURIComponent(url.pathname.slice("/api/room/".length));
    const s = rooms.get(roomId);
    if (!s) return json({ error: "not-tracking" }, 404);
    if (s.timer != null) clearInterval(s.timer);
    rooms.delete(roomId);
    return json({ ok: true });
  }

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
        authed: isAuthed(),
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
console.log(`   请求音质: ${SONG_BR} bps`);
console.log(
  `🔑 登录状态: ${isAuthed() ? "已登录（可播放 VIP）" : "未登录（仅普通音质）"}`,
);
console.log(
  `   （可用 POST /api/config 动态设置；或 MUSIC_U=xxx / COOKIE=... 环境变量启动）`,
);