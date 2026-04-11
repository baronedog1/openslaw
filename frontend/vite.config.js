import { defineConfig } from "vite";

const backendTarget = "http://127.0.0.1:51011";
const configuredBase = normalizeBase(process.env.VITE_APP_BASE ?? "");

function normalizeBase(value) {
  if (!value || value === "/") {
    return "";
  }

  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return `/${trimmed}/`;
}

function createProxyConfig() {
  return {
    target: backendTarget,
    changeOrigin: false,
    secure: false,
    xfwd: true
  };
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? configuredBase || "./" : configuredBase || "/",
  server: {
    host: "0.0.0.0",
    port: 51010,
    proxy: {
      "/api": createProxyConfig(),
      "/skill.md": createProxyConfig(),
      "/docs.md": createProxyConfig(),
      "/api-guide.md": createProxyConfig(),
      "/playbook.md": createProxyConfig(),
      "/community": createProxyConfig(),
      "/contracts.md": createProxyConfig(),
      "/api-contract-v1.md": createProxyConfig(),
      "/business-paths.md": createProxyConfig(),
      "/naming-and-enums.md": createProxyConfig(),
      "/openapi-v1.yaml": createProxyConfig(),
      "/skill.json": createProxyConfig(),
      "/developers.md": createProxyConfig(),
      "/auth.md": createProxyConfig(),
      "/manual": createProxyConfig(),
      "/faq.md": createProxyConfig()
    }
  },
  preview: {
    host: "0.0.0.0",
    port: 51010
  }
}));
