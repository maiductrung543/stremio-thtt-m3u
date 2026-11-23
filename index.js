const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const http = require("http");

const M3U_URL = process.env.M3U_URL || "https://tinyurl.com/thtt1";
const CACHE_TTL_MS = 3 * 60 * 1000; // Cache 3 phút để tránh tải lại M3U liên tục

let cache = {
  expiresAt: 0,
  items: []
};

const manifest = {
  id: "org.thtt.m3u.addon",
  version: "1.0.0",
  name: "THTT M3U TV",
  description: "Addon Stremio đọc luồng từ link M3U THTT",
  resources: ["catalog", "stream"],
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "thtt_m3u_catalog",
      name: "Danh sách kênh THTT",
      extra: [{ name: "search", isRequired: false }]
    }
  ],
  idPrefixes: ["thtt_"]
};

const builder = new addonBuilder(manifest);

// Hàm phân tích nội dung file M3U thành danh sách kênh/luồng
function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/);
  const itemsMap = new Map();
  let currentMeta = null;
  let indexCounter = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(",");
      const title = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : `Kênh ${indexCounter + 1}`;

      currentMeta = {
        name: title || `Kênh ${indexCounter + 1}`,
        poster: logoMatch && logoMatch[1] ? logoMatch[1].trim() : "",
        group: groupMatch && groupMatch[1] ? groupMatch[1].trim() : "Tổng hợp"
      };
    } else if (!line.startsWith("#")) {
      // Dòng URL luồng phát
      const streamUrl = line;
      indexCounter += 1;

      const meta = currentMeta || {
        name: `Luồng ${indexCounter}`,
        poster: "",
        group: "Tổng hợp"
      };

      // Gom các luồng trùng tên thành 1 mục có nhiều stream để người dùng chọn luồng
      const key = meta.name.toLowerCase();
      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          id: `thtt_${itemsMap.size + 1}`,
          name: meta.name,
          poster: meta.poster || undefined,
          posterShape: "landscape",
          genres: [meta.group],
          streams: []
        });
      }

      const entry = itemsMap.get(key);
      entry.streams.push({
        title: `${meta.name} (Luồng ${entry.streams.length + 1})`,
        url: streamUrl
      });

      currentMeta = null;
    }
  }

  return Array.from(itemsMap.values());
}

// Tải và cache danh sách M3U
async function getPlaylistItems() {
  const now = Date.now();
  if (cache.items.length > 0 && now < cache.expiresAt) {
    return cache.items;
  }

  try {
    const res = await fetch(M3U_URL, { timeout: 10000 });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    const parsed = parseM3U(text);

    if (parsed.length > 0) {
      cache = {
        expiresAt: now + CACHE_TTL_MS,
        items: parsed
      };
    }
    return cache.items;
  } catch (err) {
    console.error("Lỗi tải M3U:", err.message);
    return cache.items;
  }
}

// Handler danh mục (Catalog)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "tv" || id !== "thtt_m3u_catalog") {
    return { metas: [] };
  }

  let items = await getPlaylistItems();

  if (extra && extra.search) {
    const q = extra.search.toLowerCase().trim();
    items = items.filter((item) => item.name.toLowerCase().includes(q));
  }

  const metas = items.map((item) => ({
    id: item.id,
    type: "tv",
    name: item.name,
    poster: item.poster,
    posterShape: item.posterShape,
    genres: item.genres
  }));

  return { metas };
});

// Handler luồng phát (Stream)
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("thtt_")) {
    return { streams: [] };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);

  if (!found) {
    return { streams: [] };
  }

  return { streams: found.streams };
});

// Xuất handler cho Vercel Serverless Function hoặc chạy server độc lập
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

module.exports = (req, res) => {
  router(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
};

if (require.main === module) {
  const port = process.env.PORT || 7000;
  const server = http.createServer((req, res) => {
    router(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });
  server.listen(port, () => {
    console.log(`Addon đang chạy tại http://localhost:${port}/manifest.json`);
  });
}
