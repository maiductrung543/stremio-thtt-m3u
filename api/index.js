const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const CACHE_TTL_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

const M3U_URL = process.env.M3U_XOI_CHE || "https://tinyurl.com/xoiche1";
const GROUP_NAME = "Xôi Chè TV";
const ID_PREFIX = "thtt_";
const BALL_LOGO_URL =
  "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/26bd.png";

let cache = {
  expiresAt: 0,
  items: []
};

const manifest = {
  id: "org.thtt.m3u.addon",
  version: "1.4.0",
  name: "Thể Thao BLTV",
  description: "Addon Stremio xem luồng trực tiếp từ nguồn Xôi Chè TV",
  logo: BALL_LOGO_URL,
  resources: ["catalog", "stream"],
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "catalog_xoi_che_tv",
      name: "Xôi Chè TV",
      extra: [{ name: "search", isRequired: false }]
    }
  ],
  idPrefixes: [ID_PREFIX]
};

const builder = new addonBuilder(manifest);

function normalizeText(str = "") {
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

function createEmptyMeta(fallbackIndex) {
  return {
    name: `${GROUP_NAME} ${fallbackIndex}`,
    poster: "",
    userAgent: "",
    referer: ""
  };
}

function parseM3U(m3uText) {
  const lines = String(m3uText || "").split(/\r?\n/);
  const itemsMap = new Map();
  let currentMeta = null;
  let streamIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const uaMatch = line.match(/http-user-agent="([^"]*)"/i);
      const refMatch = line.match(/http-referrer="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(",");
      const title =
        commaIdx !== -1
          ? line.slice(commaIdx + 1).trim()
          : `${GROUP_NAME} ${streamIndex + 1}`;

      currentMeta = {
        name: title || `${GROUP_NAME} ${streamIndex + 1}`,
        poster: logoMatch && logoMatch[1] ? logoMatch[1].trim() : "",
        userAgent: uaMatch && uaMatch[1] ? uaMatch[1].trim() : "",
        referer: refMatch && refMatch[1] ? refMatch[1].trim() : ""
      };
      continue;
    }

    if (line.startsWith("#EXTVOPT:")) {
      if (!currentMeta) {
        currentMeta = createEmptyMeta(streamIndex + 1);
      }
      const uaOpt = line.match(/http-user-agent=([^\s,]+)/i);
      const refOpt = line.match(/http-referrer=([^\s,]+)/i);
      if (uaOpt && uaOpt[1]) currentMeta.userAgent = uaOpt[1].trim();
      if (refOpt && refOpt[1]) currentMeta.referer = refOpt[1].trim();
      continue;
    }

    if (!line.startsWith("#")) {
      streamIndex += 1;
      const meta = currentMeta || createEmptyMeta(streamIndex);
      const key = normalizeText(meta.name) || `${GROUP_NAME.toLowerCase()}_${streamIndex}`;

      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          id: `${ID_PREFIX}${itemsMap.size + 1}`,
          name: meta.name,
          poster: meta.poster || undefined,
          posterShape: "landscape",
          genres: [GROUP_NAME],
          streams: []
        });
      }

      const entry = itemsMap.get(key);
      const streamObj = {
        title: `[${GROUP_NAME}] ${meta.name} (Luồng ${entry.streams.length + 1})`,
        url: line,
        behaviorHints: {
          notWebReady: false
        }
      };

      if (meta.userAgent || meta.referer) {
        streamObj.behaviorHints.proxyHeaders = {
          request: {
            ...(meta.userAgent ? { "User-Agent": meta.userAgent } : {}),
            ...(meta.referer ? { Referer: meta.referer } : {})
          }
        };
      }

      entry.streams.push(streamObj);
      currentMeta = null;
    }
  }

  return Array.from(itemsMap.values());
}

async function getPlaylistItems() {
  const now = Date.now();
  if (cache.items.length > 0 && now < cache.expiresAt) {
    return cache.items;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(M3U_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const parsed = parseM3U(text);

    if (parsed.length > 0) {
      cache = {
        expiresAt: now + CACHE_TTL_MS,
        items: parsed
      };
    }

    return cache.items;
  } catch (err) {
    console.error(`Lỗi tải M3U (${M3U_URL}):`, err.message);
    return cache.items;
  } finally {
    clearTimeout(timer);
  }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "tv" || id !== "catalog_xoi_che_tv") {
    return { metas: [] };
  }

  let items = await getPlaylistItems();

  if (extra && extra.search) {
    const keyword = normalizeText(extra.search);
    items = items.filter((item) => normalizeText(item.name).includes(keyword));
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

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith(ID_PREFIX)) {
    return { streams: [] };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);

  return { streams: found ? found.streams : [] };
});

const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

module.exports = (req, res) => {
  router(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
};
