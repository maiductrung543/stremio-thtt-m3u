const crypto = require("crypto");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const M3U_URL = "https://tinyurl.com/xoiche1";
const CACHE_TTL_MS = 2 * 60 * 1000; // Cache 2 phút
const FETCH_TIMEOUT_MS = 8000;
const MEDIA_TYPE = "sport";
const CATALOG_ID = "xoiche_m3u_catalog";
const CATALOG_NAME = "Thể Thao - Bình Luận Tiếng Việt";

// Ảnh 2: Quả bóng đá hiệu ứng vệt màu (poster / logo)
const DEFAULT_POSTER =
  "https://raw.githubusercontent.com/maiductrung543/stremio-xoiche-m3u/refs/heads/main/IMG_9239.png";

// Ảnh 4: Sân vận động ánh đèn xanh/trắng (ảnh nền chi tiết trận đấu)
const DEFAULT_BACKGROUND =
  "https://raw.githubusercontent.com/maiductrung543/stremio-xoiche-m3u/refs/heads/main/IMG_9240.jpeg";

let cachedItems = null;
let lastFetchTime = 0;
let inFlightPromise = null;

function toId(str) {
  const hash = crypto.createHash("sha1").update(str, "utf8").digest("hex").slice(0, 16);
  return `m3u_${hash}`;
}

function decodeBase64UrlSafe(b64) {
  try {
    return Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function parseExtInf(line) {
  const commaIdx = line.lastIndexOf(",");
  const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : "Trận đấu trực tiếp";

  const groupMatch = line.match(/group-title=["']([^"']+)["']/i);
  const group = groupMatch ? groupMatch[1].trim() : "Bóng đá trực tiếp";

  const uaMatch = line.match(/http-user-agent=["']([^"']+)["']/i);
  const refererMatch = line.match(/http-referrer=["']([^"']+)["']/i);

  const headers = {};
  if (uaMatch && uaMatch[1].trim()) {
    headers["User-Agent"] = uaMatch[1].trim();
  }
  if (refererMatch && refererMatch[1].trim()) {
    headers["Referer"] = refererMatch[1].trim();
  }

  return { name, group, headers };
}

function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/);
  const grouped = new Map();

  let currentItem = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const parsedInfo = parseExtInf(line);
      currentItem = {
        name: parsedInfo.name || "Trận đấu trực tiếp",
        group: parsedInfo.group || "Bóng đá trực tiếp",
        headers: parsedInfo.headers
      };
    } else if (line.startsWith("#EXTVLCOPT:") || line.startsWith("#EXTHTTP:")) {
      if (currentItem) {
        const vlcUa = line.match(/http-user-agent=(.+)$/i);
        const vlcRef = line.match(/http-referrer=(.+)$/i);
        if (vlcUa && vlcUa[1].trim()) {
          currentItem.headers["User-Agent"] = vlcUa[1].trim();
        }
        if (vlcRef && vlcRef[1].trim()) {
          currentItem.headers["Referer"] = vlcRef[1].trim();
        }
      }
      // Không reset currentItem vì dòng URL nằm ở dòng tiếp theo
    } else if (!line.startsWith("#")) {
      const streamUrl = line;
      if (currentItem && /^https?:\/\//i.test(streamUrl)) {
        const key = currentItem.name.toLowerCase();
        if (!grouped.has(key)) {
          grouped.set(key, {
            id: toId(currentItem.name),
            name: currentItem.name,
            poster: DEFAULT_POSTER,
            background: DEFAULT_BACKGROUND,
            group: currentItem.group,
            streams: []
          });
        }

        const entry = grouped.get(key);
        const exists = entry.streams.some((s) => s.url === streamUrl);
        if (!exists) {
          entry.streams.push({
            url: streamUrl,
            headers: { ...currentItem.headers }
          });
        }
      }
      currentItem = null;
    }
  }

  return Array.from(grouped.values());
}

async function fetchAndParseM3U() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(M3U_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StremioM3U/1.1"
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    const parsed = parseM3U(text);

    if (parsed.length > 0) {
      cachedItems = parsed;
      lastFetchTime = Date.now();
    }

    return cachedItems || [];
  } catch (err) {
    console.error("Lỗi tải M3U:", err.message);
    return cachedItems || [];
  } finally {
    clearTimeout(timeout);
  }
}

async function getPlaylistItems() {
  const now = Date.now();
  if (cachedItems && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedItems;
  }

  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = fetchAndParseM3U().finally(() => {
    inFlightPromise = null;
  });

  return inFlightPromise;
}

const manifest = {
  id: "org.trung.xoiche.m3u",
  version: "1.1.0",
  name: "Xôi Chè TV",
  description: "Trực tiếp bóng đá và thể thao bình luận tiếng Việt",
  logo: DEFAULT_POSTER,
  background: DEFAULT_BACKGROUND,
  types: [MEDIA_TYPE],
  catalogs: [
    {
      type: MEDIA_TYPE,
      id: CATALOG_ID,
      name: CATALOG_NAME,
      posterShape: "landscape",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ],
  resources: ["catalog", "meta", "stream"],
  idPrefixes: ["m3u_"]
};

const builder = new addonBuilder(manifest);

// 1. Danh mục (Catalog + Tìm kiếm + Phân trang skip)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== MEDIA_TYPE || id !== CATALOG_ID) {
    return { metas: [] };
  }

  let items = await getPlaylistItems();

  if (extra && extra.search) {
    const q = extra.search.trim().toLowerCase();
    items = items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.group && item.group.toLowerCase().includes(q))
    );
  }

  const skip = extra && extra.skip ? Math.max(0, parseInt(extra.skip, 10) || 0) : 0;
  if (skip > 0) {
    items = items.slice(skip);
  }

  const metas = items.map((item) => ({
    id: item.id,
    type: MEDIA_TYPE,
    name: item.name,
    poster: item.poster || DEFAULT_POSTER,
    posterShape: "landscape",
    background: item.background || DEFAULT_BACKGROUND,
    genres: item.group ? [item.group] : [],
    behaviorHints: {
      isLive: true
    }
  }));

  return { metas };
});

// 2. Chi tiết trận đấu (Meta)
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== MEDIA_TYPE || !id || !id.startsWith("m3u_")) {
    return { meta: null };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);

  // Tương thích ngược nếu có ID cũ dạng base64url
  const legacyDecoded = !found && id.length > 20 ? decodeBase64UrlSafe(id.slice(4)) : null;
  const displayName = found ? found.name : legacyDecoded || "Trận đấu trực tiếp";

  return {
    meta: {
      id,
      type: MEDIA_TYPE,
      name: displayName,
      poster: DEFAULT_POSTER,
      posterShape: "landscape",
      background: DEFAULT_BACKGROUND,
      description: found
        ? `${CATALOG_NAME} • Nhóm: ${found.group || "Thể thao"} • Số luồng: ${found.streams.length}`
        : `${CATALOG_NAME} • Luồng phát trực tiếp`,
      behaviorHints: {
        isLive: true
      }
    }
  };
});

// 3. Danh sách luồng phát (Stream)
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== MEDIA_TYPE || !id || !id.startsWith("m3u_")) {
    return { streams: [] };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);

  if (!found || !found.streams.length) {
    return { streams: [] };
  }

  const streams = found.streams.map((streamObj, idx) => {
    const streamItem = {
      name: found.streams.length > 1 ? `⚽ Link ${idx + 1}` : "⚽ Xem Trực Tiếp",
      title: found.name,
      url: streamObj.url,
      behaviorHints: {
        notWebReady: false
      }
    };

    if (streamObj.headers && Object.keys(streamObj.headers).length > 0) {
      streamItem.behaviorHints.proxyHeaders = {
        request: streamObj.headers
      };
    }

    return streamItem;
  });

  return { streams };
});

const router = getRouter(builder.getInterface());

module.exports = (req, res) => {
  const cleanUrl = (req.url || "/").split("?")[0];
  if (cleanUrl === "/" || cleanUrl === "") {
    res.writeHead(302, { Location: "/manifest.json" });
    return res.end();
  }

  router(req, res, (err) => {
    if (err) {
      res.statusCode = 500;
      res.end("Internal Server Error");
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });
};
