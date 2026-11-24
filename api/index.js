const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const M3U_URL = "https://tinyurl.com/xoiche1";
const CACHE_TTL_MS = 2 * 60 * 1000; // Cache 2 phút để giảm tải gọi M3U liên tục

let cachedItems = null;
let lastFetchTime = 0;

// Tạo ID an toàn dạng base64url cho từng mục trong M3U
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

// Phân tích nội dung file M3U thành danh sách kênh/trận đấu
function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/);
  const grouped = new Map();

  let currentName = null;
  let currentLogo = null;
  let currentGroup = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      // Lấy tên hiển thị sau dấu phẩy cuối cùng
      const commaIdx = line.lastIndexOf(",");
      currentName = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : "Kênh chưa đặt tên";

      // Lấy logo nếu có
      const logoMatch = line.match(/tvg-logo=["']([^"']+)["']/i);
      currentLogo = logoMatch ? logoMatch[1].trim() : null;

      // Lấy group-title nếu có
      const groupMatch = line.match(/group-title=["']([^"']+)["']/i);
      currentGroup = groupMatch ? groupMatch[1].trim() : "IPTV / Trực tiếp";
    } else if (!line.startsWith("#")) {
      // Dòng này là URL luồng phát
      const streamUrl = line;
      if (currentName && /^https?:\/\//i.test(streamUrl)) {
        const key = currentName.toLowerCase();
        if (!grouped.has(key)) {
          grouped.set(key, {
            id: toId(currentName),
            name: currentName,
            logo: currentLogo,
            group: currentGroup,
            streams: []
          });
        }
        const entry = grouped.get(key);
        if (!entry.streams.includes(streamUrl)) {
          entry.streams.push(streamUrl);
        }
        if (!entry.logo && currentLogo) entry.logo = currentLogo;
      }
      currentName = null;
      currentLogo = null;
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
  version: "1.0.0",
  name: "Xoiche M3U Stream",
  description: "Danh sách phát M3U từ xoiche1 cho Stremio",
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
    poster: item.logo || undefined,
    posterShape: "landscape",
    genres: item.group ? [item.group] : []
  }));

  return { metas };
});

// 2. Chi tiết mục (Meta)
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("m3u_")) {
    return { meta: null };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);
  const decodedName = fromId(id) || "Kênh phát";

  return {
    meta: {
      id,
      type: "tv",
      name: found ? found.name : decodedName,
      poster: found && found.logo ? found.logo : undefined,
      posterShape: "landscape",
      description: found
        ? `Nhóm: ${found.group || "M3U"} • Số luồng: ${found.streams.length}`
        : "Luồng phát từ danh sách M3U"
    }
  };
});

// 3. Danh sách link phát (Stream)
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
    name: found.streams.length > 1 ? `Link ${idx + 1}` : "Xoiche M3U",
    title: `${found.name}\n${url}`,
    url
  }));

  return { streams };
});

const router = getRouter(builder.getInterface());

module.exports = (req, res) => {
  // Chuyển hướng trang gốc / sang /manifest.json để dễ kiểm tra
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
