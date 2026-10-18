import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_SCHEMA_PATH, cliSchemaJson } from "./gen-contracts";

describe("생성된 CLI schema", () => {
  it("packages/contracts 원본과 같다 (다르면 npm run gen:contracts)", () => {
    expect(readFileSync(CLI_SCHEMA_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(cliSchemaJson());
  });

  it("CLI가 거부하는 $schema·$id가 없다", () => {
    const schema = JSON.parse(cliSchemaJson());
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("$id");
  });
});
