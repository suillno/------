// packages/contracts의 분석 결과 schema에서 Claude CLI용 JSON을 만든다.
// 실행: npm run gen:contracts  (생성 파일은 직접 수정하지 않는다)
// CLI는 draft 2020-12 $schema를 거부하므로 $schema·$id를 뺀다 (docs/adr/0002-claude-cli-invocation.md).

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analysisResultV1Schema } from "../packages/contracts/src/analysis.ts";

export const CLI_SCHEMA_PATH = "apps/desktop/src-tauri/generated/analysis-result-v1.cli-schema.json";

export function cliSchemaJson(): string {
  const { $schema: _schema, $id: _id, ...rest } = analysisResultV1Schema;
  return `${JSON.stringify(rest)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  writeFileSync(CLI_SCHEMA_PATH, cliSchemaJson());
  console.log(`생성: ${CLI_SCHEMA_PATH}`);
}
