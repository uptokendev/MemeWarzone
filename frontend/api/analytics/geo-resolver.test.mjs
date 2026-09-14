import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicClientIp,
  parseGeoLookupPayload,
  resolveGeoContext,
  trustedGeoContext,
} from "./geo-resolver.js";

test("trusted edge country wins without external lookup", async () => {
  let calls = 0;
  const req = { headers: { "cf-ipcountry": "NL", "cf-region": "NH" } };
  const geo = await resolveGeoContext(req, "203.0.113.10", async () => {
    calls += 1;
    throw new Error("should not call");
  });
  assert.deepEqual(geo, { country: "NL", region: "NH", source: "edge" });
  assert.equal(calls, 0);
});

test("geo lookup persists only country and region fields", async () => {
  const req = { headers: {} };
  const geo = await resolveGeoContext(req, "8.8.8.8", async (url) => {
    assert.match(String(url), /8\.8\.8\.8/);
    return {
      ok: true,
      async json() {
        return {
          success: true,
          country_code: "US",
          region_code: "CA",
          city: "Mountain View",
          latitude: 37.4,
          longitude: -122.1,
          ip: "8.8.8.8",
        };
      },
    };
  });
  assert.deepEqual(geo, { country: "US", region: "CA", source: "geoip" });
  assert.equal("city" in geo, false);
  assert.equal("latitude" in geo, false);
  assert.equal("longitude" in geo, false);
  assert.equal("ip" in geo, false);
});

test("private and loopback addresses never leave the server", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.4", "172.16.0.2", "192.168.1.5", "::1", "fd00::1"]) {
    let calls = 0;
    const geo = await resolveGeoContext({ headers: {} }, ip, async () => {
      calls += 1;
      return { ok: true, async json() { return { success: true, country_code: "NL" }; } };
    });
    assert.deepEqual(geo, { country: undefined, region: undefined, source: undefined });
    assert.equal(calls, 0);
  }
});

test("invalid geo payload fails closed", () => {
  assert.deepEqual(parseGeoLookupPayload({ success: false, country_code: "NL" }), {});
  assert.deepEqual(parseGeoLookupPayload({ success: true, country_code: "XX" }), {
    country: undefined,
    region: undefined,
    source: undefined,
  });
});

test("public ip detection excludes local ranges", () => {
  assert.equal(isPublicClientIp("8.8.8.8"), true);
  assert.equal(isPublicClientIp("1.1.1.1"), true);
  assert.equal(isPublicClientIp("192.168.1.1"), false);
  assert.equal(isPublicClientIp("not-an-ip"), false);
});

test("trustedGeoContext ignores sentinel countries", () => {
  assert.deepEqual(trustedGeoContext({ headers: { "cf-ipcountry": "T1" } }), {
    country: undefined,
    region: undefined,
    source: undefined,
  });
});
