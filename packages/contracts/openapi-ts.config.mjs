import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "openapi.yaml",
  output: "generated/typescript",
});
