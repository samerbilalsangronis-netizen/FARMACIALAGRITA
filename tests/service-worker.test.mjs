import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://farmacia.example";
const installed = new Response("Versión instalada");

async function navigate(fetch) {
  const handlers = new Map();
  const self = {
    PHARMACY_ASSETS: { version: "fixture", files: [] },
    location: { origin },
    addEventListener: (event, handler) => handlers.set(event, handler),
  };
  runInNewContext(worker, {
    self, importScripts() {}, AbortController, setTimeout, clearTimeout, URL, Request, Response, fetch,
    caches: { open: async (name) => {
      assert.equal(name, "pharmacy-shell-fixture");
      return { match: async (request) => {
        assert.equal(request.url, origin + "/");
        return installed.clone();
      } };
    } },
  });
  let response;
  handlers.get("fetch")({
    request: { method: "GET", mode: "navigate", url: origin + "/" },
    respondWith: (result) => { response = result; },
  });
  return (await response).text();
}

test("La navegación con conexión muestra la versión publicada aunque exista una versión instalada", async () => {
  assert.equal(await navigate(async (_request, options) => {
    assert.equal(options.cache, "no-cache");
    return new Response("Versión publicada");
  }), "Versión publicada");
});

test("La navegación usa la versión instalada cuando la red falla", async () => {
  assert.equal(await navigate(async () => { throw new Error("Sin conexión"); }), "Versión instalada");
  assert.equal(await navigate(async () => new Response("Error", { status: 503 })), "Versión instalada");
});
