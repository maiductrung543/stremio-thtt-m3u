const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const CACHE_TTL_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const STREAM_TYPE = "movie";
const ID_PREFIX = "thtt_";

const M3U_SOURCES = [
  {
    catalogId: "catalog_truyen_hinh",
    url: process.env.M3U_TRUYEN_HINH || "https://tinyurl.com/vietxiaomi",
    groupName: "Truyền Hình",
    forceGroup: true,
    allowedGroupKeyword: null
  },
  {
    catalogId: "catalog_xoi_che_tv",
    url: process.env.M3U_XOI_CHE || "https://tinyurl.com/xoiche1",
    groupName: "Xôi Chè TV",
    forceGroup: true,
    allowedGroupKeyword: null
  },
  {
    catalogId: "catalog_gio_vang_tv",
    url: process.env.M3U_GIO_VANG || "https://thtt.pages.dev/tttt.m3u",
    groupName: "Giờ Vàng TV",
    forceGroup: true,
    allowedGroupKeyword: "gio vang tv"
  }
];

let cache = {
  expiresAt: 0,
  items: []
};

const manifest = {
  id: "org.thtt.m3u.addon",
  version: "1.3.0",
  name: "THTT M3U TV",
  description: "Addon Stremio hiển thị kênh ra ngoài dạng thẻ ngang giống mục Phim lẻ",
  resources: ["catalog", "stream"],
  types: [STREAM_TYPE],
  catalogs: [
    {
      type: STREAM_TYPE,
      id: "catalog_truyen_hinh",
      name: "Truyền Hình",
      extra: [{ name: "search", isRequired: false }]
    },
    {
      type: STREAM_TYPE,
      id: "catalog_xoi_che_tv",
      name: "Xôi Chè TV",
      extra: [{ name: "search", isRequired: false }]
    },
    {
      type: STREAM_TYPE,
      id: "catalog_gio_vang_tv",
      name: "Giờ Vàng TV",
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

function parseM3UForSource(m3uText, sourceConfig, itemsMap) {
  const lines = m3uText.split(/\r?\n/);
  let currentMeta = null;
  let indexCounter = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(",");
      const title =
        commaIdx !== -1
          ? line.slice(commaIdx + 1).trim()
          : `${sourceConfig.groupName} ${indexCounter + 1}`;

      currentMeta = {
        name: title || `${sourceConfig.groupName} ${indexCounter + 1}`,
        poster: logoMatch && logoMatch[1] ? logoMatch[1].trim() : "",
        rawGroup: groupMatch && groupMatch[1] ? groupMatch[1].trim() : ""
      };
    } else if (!line.startsWith("#")) {
      const streamUrl = line;
      indexCounter += 1;

      const meta = currentMeta || {
        name: `${sourceConfig.groupName} ${indexCounter}`,
        poster: "",
        rawGroup: ""
      };

      // Chỉ lọc lấy mục thuộc nhóm Giờ Vàng TV từ nguồn tttt.m3u
      if (sourceConfig.allowedGroupKeyword) {
        const normRawGroup = normalizeText(meta.rawGroup);
        const normKeyword = normalizeText(sourceConfig.allowedGroupKeyword);
        if (!normRawGroup.includes(normKeyword)) {
          currentMeta = null;
          continue;
        }
      }

      const assignedGroup = sourceConfig.forceGroup
        ? sourceConfig.groupName
        : meta.rawGroup || sourceConfig.groupName;

      const key = `${sourceConfig.catalogId}__${normalizeText(meta.name)}`;
      if (!itemsMap.has(key)) {
        itemsMap.set(key, {
          id: `${ID_PREFIX}${itemsMap.size + 1}`,
          catalogId: sourceConfig.catalogId,
          name: meta.name,
          poster: meta.poster || undefined,
          posterShape: "landscape",
          genres: [assignedGroup],
          streams: []
        });
      }

      const entry = itemsMap.get(key);
      entry.streams.push({
        title: `[${assignedGroup}] ${meta.name} (Luồng ${entry.streams.length + 1})`,
        url: streamUrl
      });

      currentMeta = null;
    }
  }
}

async function fetchSingleSource(sourceConfig) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(sourceConfig.url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } catch (err) {
    console.error(`Lỗi tải nguồn [${sourceConfig.groupName}] (${sourceConfig.url}):`, err.message);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function getPlaylistItems() {
  const now = Date.now();
  if (cache.items.length > 0 && now < cache.expiresAt) {
    return cache.items;
  }

  const itemsMap = new Map();

  await Promise.all(
    M3U_SOURCES.map(async (sourceConfig) => {
      const text = await fetchSingleSource(sourceConfig);
      if (text) {
        parseM3UForSource(text, sourceConfig, itemsMap);
      }
    })
  );

  const parsed = Array.from(itemsMap.values());
  if (parsed.length > 0) {
    cache = {
      expiresAt: now + CACHE_TTL_MS,
      items: parsed
    };
  }

  return cache.items;
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const validCatalogIds = M3U_SOURCES.map((s) => s.catalogId);
  if (type !== STREAM_TYPE || !validCatalogIds.includes(id)) {
    return { metas: [] };
  }

  let items = await getPlaylistItems();
  items = items.filter((item) => item.catalogId === id);

  if (extra && extra.search) {
    const q = normalizeText(extra.search);
    items = items.filter((item) => normalizeText(item.name).includes(q));
  }

  const metas = items.map((item) => ({
    id: item.id,
    type: STREAM_TYPE,
    name: item.name,
    poster: item.poster,
    posterShape: item.posterShape,
    genres: item.genres
  }));

  return { metas };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== STREAM_TYPE || !id.startsWith(ID_PREFIX)) {
    return { streams: [] };
  }

  const items = await getPlaylistItems();
  const found = items.find((item) => item.id === id);

  if (!found) {
    return { streams: [] };
  }

  return { streams: found.streams };
});

const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

module.exports = (req, res) => {
  router(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
};
