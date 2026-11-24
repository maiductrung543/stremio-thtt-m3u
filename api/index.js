const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const M3U_URL = "https://tinyurl.com/xoiche1";
const CACHE_TTL_MS = 2 * 60 * 1000; // Cache 2 phút

// Ảnh logo quả bóng đá chuẩn vuông gọn khung
const DEFAULT_LOGO =
  "https://images.unsplash.com/photo-1614632537423-1e6c2e7e0aab?auto=format&fit=crop&w=256&h=256&q=80";

// Ảnh sân vận động / khán đài bóng đá cho poster & hình nền
const DEFAULT_POSTER =
  "https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=800&h=450&q=80";

let cachedItems = null;
let lastFetchTime = 0;

function toId(str) {
  return "m3u_" + Buffer.from(str, "utf8").toString("base64url");
}

function fromId(id) {
  if (!id || !id.startsWith("m3u_")) return null;
  try {
    return Buffer.from(id.slice(4), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/);
  const grouped = new Map();

  let currentName = null;
  let currentGroup = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const commaIdx = line.lastIndexOf(",");
      currentName = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : "Trận đấu trực tiếp";

      const groupMatch = line.match(/group-title=["']([^"']+)["']/i);
      currentGroup = groupMatch ? groupMatch[1].trim() : "Bóng đá trực tiếp";
    } else if (!line.startsWith("#")) {
      const streamUrl = line;
      if (currentName && /^https?:\/\//i.test(streamUrl)) {
        const key = currentName.toLowerCase();
        if (!grouped.has(key)) {
          grouped.set(key, {
            id: toId(currentName),
            name: currentName,
            logo: DEFAULT_LOGO,
            poster: DEFAULT_POSTER,
            group: currentGroup,
            streams: []
          });
        }
        const entry = grouped.get(key);
        if (!entry.streams.includes(streamUrl)) {
          entry.streams.push(streamUrl);
        }
      }
      currentName = null;
      currentGroup = null;
    }
  }

  return Array.from(grouped.values());
}

async function getPlaylistItems() {
  const now = Date.now();
  if (cachedItems && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedItems;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(M3U_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StremioM3U/1.0"
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const text = await res.text();
    const parsed = parseM3U(text);

    if (parsed.length > 0) {
      cachedItems = parsed;
      lastFetchTime = now;
    }
    return cachedItems || [];
  } catch (err) {
    console.error("Lỗi tải M3U:", err.message);
    return cachedItems || [];
  } finally {
    clearTimeout(timeout);
  }
}

const manifest = {
  id: "org.trung.xoiche.m3u",
  version: "1.0.1",
  name: "Xoiche M3U Stream",
  description: "Trực tiếp bóng đá từ danh sách phát Xoiche M3U",
  logo: DEFAULT_LOGO,
  background: DEFAULT_POSTER,
  types: ["tv", "other"],
  catalogs: [
    {
      type: "tv",
      id: "xoiche_m3u_catalog",
      name: "Xoiche M3U",
      extra: [{ name: "search", isRequired: false }]
    }
  ],
  resources: ["catalog", "meta", "stream"],
  idPrefixes: ["m3u_"]
};

const builder = new addonBuilder(manifest);

// 1. Danh mục (Catalog + Tìm kiếm)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "tv" || id !== "xoiche_m3u_catalog") {
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

  const metas = items.map((item) => ({
    id: item.id,
    type: "tv",
    name: item.name,
    poster: item.poster,
    posterShape: "landscape",
    logo: item.logo,
    background: item.poster,
    genres: item.group ? [item.group] : []
  }));

  return { metas };
});

// 2. Chi tiết trận đấu (Meta)
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("m3u_")) {
    return { meta: null };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);
  const decodedName = fromId(id) || "Trận đấu trực tiếp";

  return {
    meta: {
      id,
      type: "tv",
      name: found ? found.name : decodedName,
      poster: DEFAULT_POSTER,
      posterShape: "landscape",
      background: DEFAULT_POSTER,
      description: found
        ? `Nhóm: ${found.group || "Bóng đá"} • Số luồng: ${found.streams.length}`
        : "Luồng phát trực tiếp"
    }
  };
});

// 3. Danh sách luồng phát (Stream - Đã ẩn link m3u8)
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("m3u_")) {
    return { streams: [] };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);

  if (!found || !found.streams.length) {
    return { streams: [] };
  }

  const streams = found.streams.map((url, idx) => ({
    name: found.streams.length > 1 ? `⚽ Link ${idx + 1}` : "⚽ Xem Trực Tiếp",
    title: found.name,
    url
  }));

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
