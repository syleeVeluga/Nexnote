import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { assertUrlSafe, isPrivateIP } from "./url-safety.js";

describe("isPrivateIP", () => {
  it("rejects IPv4 loopback", () => {
    assert.equal(isPrivateIP("127.0.0.1"), true);
    assert.equal(isPrivateIP("127.255.255.254"), true);
  });
  it("rejects IPv4 RFC1918 ranges", () => {
    assert.equal(isPrivateIP("10.0.0.1"), true);
    assert.equal(isPrivateIP("10.255.255.255"), true);
    assert.equal(isPrivateIP("172.16.0.1"), true);
    assert.equal(isPrivateIP("172.31.255.255"), true);
    assert.equal(isPrivateIP("192.168.1.1"), true);
  });
  it("rejects link-local and cloud metadata", () => {
    assert.equal(isPrivateIP("169.254.0.1"), true);
    assert.equal(isPrivateIP("169.254.169.254"), true);
  });
  it("rejects CGNAT 100.64/10", () => {
    assert.equal(isPrivateIP("100.64.0.1"), true);
    assert.equal(isPrivateIP("100.127.255.255"), true);
  });
  it("rejects multicast and reserved high ranges", () => {
    assert.equal(isPrivateIP("224.0.0.1"), true);
    assert.equal(isPrivateIP("255.255.255.255"), true);
  });
  it("rejects 0.0.0.0/8", () => {
    assert.equal(isPrivateIP("0.0.0.0"), true);
    assert.equal(isPrivateIP("0.1.2.3"), true);
  });
  it("accepts public IPv4 addresses", () => {
    assert.equal(isPrivateIP("8.8.8.8"), false);
    assert.equal(isPrivateIP("1.1.1.1"), false);
    assert.equal(isPrivateIP("172.15.0.1"), false); // just outside 172.16/12
    assert.equal(isPrivateIP("172.32.0.1"), false); // just outside 172.16/12
    assert.equal(isPrivateIP("100.63.255.255"), false); // just outside CGNAT
    assert.equal(isPrivateIP("100.128.0.1"), false); // just outside CGNAT
  });
  it("rejects IPv6 loopback and unspecified", () => {
    assert.equal(isPrivateIP("::1"), true);
    assert.equal(isPrivateIP("::"), true);
  });
  it("rejects IPv6 ULA fc00::/7", () => {
    assert.equal(isPrivateIP("fc00::1"), true);
    assert.equal(isPrivateIP("fd12:3456::1"), true);
  });
  it("rejects IPv6 link-local fe80::/10", () => {
    assert.equal(isPrivateIP("fe80::1"), true);
    assert.equal(isPrivateIP("fe90::1"), true);
    assert.equal(isPrivateIP("fea0::1"), true);
    assert.equal(isPrivateIP("feb0::1"), true);
  });
  it("rejects IPv4-mapped IPv6 pointing at private", () => {
    assert.equal(isPrivateIP("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIP("::ffff:10.0.0.1"), true);
  });
  it("accepts public IPv6 addresses", () => {
    assert.equal(isPrivateIP("2001:4860:4860::8888"), false);
    assert.equal(isPrivateIP("2606:4700:4700::1111"), false);
  });
  it("rejects unparseable strings conservatively", () => {
    assert.equal(isPrivateIP("not-an-ip"), true);
    assert.equal(isPrivateIP(""), true);
  });
});

describe("assertUrlSafe (synchronous guards)", () => {
  it("rejects invalid URLs", async () => {
    const r = await assertUrlSafe("not a url");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid-url");
  });
  it("rejects file:// scheme", async () => {
    const r = await assertUrlSafe("file:///etc/passwd");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported-protocol");
  });
  it("rejects ftp:// scheme", async () => {
    const r = await assertUrlSafe("ftp://example.com/foo");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported-protocol");
  });
  it("rejects gopher:// scheme", async () => {
    const r = await assertUrlSafe("gopher://example.com");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported-protocol");
  });
  it("rejects non-allowlisted ports", async () => {
    const r = await assertUrlSafe("http://example.com:22/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "port-not-allowed");
  });
  it("rejects localhost hostname", async () => {
    const r = await assertUrlSafe("http://localhost/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-host");
  });
  it("rejects *.localhost hostname", async () => {
    const r = await assertUrlSafe("http://api.localhost/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-host");
  });
  it("rejects gcp metadata hostname", async () => {
    const r = await assertUrlSafe("http://metadata.google.internal/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-host");
  });
  it("rejects literal private IPv4", async () => {
    const r = await assertUrlSafe("http://127.0.0.1/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-ip");
  });
  it("rejects literal metadata IP 169.254.169.254", async () => {
    const r = await assertUrlSafe("http://169.254.169.254/latest/meta-data/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-ip");
  });
  it("rejects literal RFC1918 IPv4", async () => {
    const r = await assertUrlSafe("http://10.0.0.5/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-ip");
  });
  it("rejects bracketed literal IPv6 loopback", async () => {
    const r = await assertUrlSafe("http://[::1]/");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "private-ip");
  });
  it("respects WEB_IMPORT_ALLOWED_PORTS override", async () => {
    const prev = process.env["WEB_IMPORT_ALLOWED_PORTS"];
    process.env["WEB_IMPORT_ALLOWED_PORTS"] = "80,443";
    try {
      const r = await assertUrlSafe("http://8.8.8.8:8080/");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "port-not-allowed");
    } finally {
      if (prev === undefined) delete process.env["WEB_IMPORT_ALLOWED_PORTS"];
      else process.env["WEB_IMPORT_ALLOWED_PORTS"] = prev;
    }
  });
});
