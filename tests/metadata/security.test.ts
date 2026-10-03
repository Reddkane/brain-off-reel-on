import { expect, it } from "vitest";
import { createTmdb } from "../../src/server/providers/tmdb.ts";
import type { ProviderContext } from "../../src/server/providers/metadata-provider.ts";
import { at, fixture, key, mapping } from "./helpers.ts";

function harness(responses: (Response | Error)[], max = 10) {
  let now = Date.parse(at);

  const calls: {
    url: string;
    options?: RequestInit;
  }[] = [];

  const ctx: ProviderContext = {
    signal: new AbortController().signal,
    now: () => now,

    budget: {
      attempts: 0,
      maxAttempts: max,
      deadline: now + 60000,
      stopped: false
    }
  };

  const provider = createTmdb("synthetic-secret", mapping, {
    sleep: async ms => {
      now += ms;
    },

    fetch: async (url, options) => {
      calls.push({
        url: String(url),
        options
      });

      const r = responses.shift();

      if (r instanceof Error)
        throw r;

      if (!r)
        throw new Error("no_fixture");

      return r;
    }
  });

  return {
    ctx,
    calls,
    provider
  };
}

it("one exact appended request; no fallback on missing component", async () => {
  const h = harness([new Response(JSON.stringify(await fixture("tmdb")))]);
  expect((await h.provider.getMovie(key, h.ctx)).status).toBe("ok");
  expect(h.calls).toHaveLength(1);
  const u = new URL(h.calls[0].url);
  expect(u.origin).toBe("https://api.themoviedb.org");
  expect(u.pathname).toBe("/3/movie/900001");
  expect([...u.searchParams]).toEqual([["language", "en-US"], ["append_to_response", "release_dates,keywords,credits,external_ids"]]);
  expect(h.calls[0].options?.redirect).toBe("error");
  expect(u.search).not.toContain("secret");
  const bad = harness([new Response("{}")]);
  expect((await bad.provider.getMovie(key, bad.ctx)).status).toBe("invalid");
  expect(bad.calls).toHaveLength(1);
});

it.each([401, 403, 404, 400])("nonretry status %s", async status => {
  const h = harness([new Response("", {
    status
  })]);

  expect((await h.provider.getMovie(key, h.ctx)).status).toBe(status === 404 ? "not_found" : "failed");
  expect(h.calls).toHaveLength(1);

  if (status === 401 || status === 403) {
    expect(h.ctx.budget.stopped).toBe(true);
    await h.provider.getMovie(key, h.ctx);
    expect(h.calls).toHaveLength(1);
  }
});

it("network and transient retries consume exact finite attempts", async () => {
  const h = harness([new Error("private error"), new Response("", {
    status: 503
  }), new Response(JSON.stringify(await fixture("tmdb")))]);

  expect((await h.provider.getMovie(key, h.ctx)).status).toBe("ok");
  expect(h.ctx.budget.attempts).toBe(3);
  expect(h.calls).toHaveLength(3);
  const b = harness([new Error("x"), new Error("x"), new Error("x")], 2);

  expect((await b.provider.getMovie(key, b.ctx))).toMatchObject({
    status: "failed",
    code: "budget"
  });

  expect(b.calls).toHaveLength(2);
});

it("global headroom stops retries and deadline stops waits", async () => {
  const h = harness([new Response("", {
    status: 503
  })], 1);

  expect((await h.provider.getMovie(key, h.ctx))).toMatchObject({
    code: "budget"
  });

  expect(h.calls).toHaveLength(1);

  const d = harness([new Response("", {
    status: 503
  })]);

  expect((await d.provider.getMovie(key, {
    ...d.ctx,

    budget: {
      ...d.ctx.budget,
      deadline: d.ctx.now() + 500
    }
  }))).toMatchObject({
    code: "deadline"
  });

  expect(d.calls).toHaveLength(1);
});

it.each(["31", "garbage", "-1"])("rejects unbounded Retry-After %s", async retry => {
  const h = harness([new Response("", {
    status: 429,

    headers: {
      "Retry-After": retry
    }
  })]);

  expect((await h.provider.getMovie(key, h.ctx))).toMatchObject({
    code: "throttled"
  });

  expect(h.calls).toHaveLength(1);
});

it("valid throttling obeys retry attempt cap and 500ms pacing", async () => {
  const h = harness([new Response("", {
    status: 429,

    headers: {
      "Retry-After": "2"
    }
  }), new Response(JSON.stringify(await fixture("tmdb")))]);

  const start = h.ctx.now();
  expect((await h.provider.getMovie(key, h.ctx)).status).toBe("ok");
  expect(h.ctx.now() - start).toBeGreaterThanOrEqual(2000);
});

it("chunked response limit and JSON errors are controlled", async () => {
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0;i < 3;i++)
        controller.enqueue(new Uint8Array(1024 * 1024));

      controller.close();
    }
  });

  const h = harness([new Response(stream)]);

  expect((await h.provider.getMovie(key, h.ctx))).toMatchObject({
    code: "body_limit"
  });

  const j = harness([new Response("{broken")]);
  expect((await j.provider.getMovie(key, j.ctx)).status).toBe("invalid");
});

it("cancellation and invalid key make zero requests", async () => {
  const h = harness([]);
  const c = new AbortController();
  c.abort();

  expect((await h.provider.getMovie(key, {
    ...h.ctx,
    signal: c.signal
  }))).toMatchObject({
    code: "cancelled"
  });

  expect((await h.provider.getMovie({
    source: "imdb",
    externalId: "tt0000001"
  }, h.ctx)).status).toBe("invalid");

  expect(h.calls).toHaveLength(0);
});
