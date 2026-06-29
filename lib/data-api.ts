import {
  ExecuteStatementCommand,
  RDSDataClient,
  type Field,
  type SqlParameter
} from "@aws-sdk/client-rds-data";
import { getEnv } from "@/lib/env";

type DataApiQueryResult<T> = {
  rows: T[];
  rowCount: number;
};

const dataApi = new RDSDataClient({});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatTimestamp(date: Date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function valueToField(value: unknown): Field {
  if (value === null || value === undefined) {
    return { isNull: true };
  }

  if (typeof value === "boolean") {
    return { booleanValue: value };
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
  }

  if (typeof value === "object") {
    return { stringValue: JSON.stringify(value) };
  }

  return { stringValue: String(value) };
}

function valueToSqlParameter(name: string, value: unknown): SqlParameter {
  if (value instanceof Date) {
    return {
      name,
      typeHint: "TIMESTAMP",
      value: { stringValue: formatTimestamp(value) }
    };
  }

  if (value && typeof value === "object") {
    return {
      name,
      typeHint: "JSON",
      value: { stringValue: JSON.stringify(value) }
    };
  }

  if (typeof value === "string" && uuidPattern.test(value)) {
    return {
      name,
      typeHint: "UUID",
      value: { stringValue: value }
    };
  }

  return {
    name,
    value: valueToField(value)
  };
}

function fieldToValue(field: Field | undefined): unknown {
  if (!field || field.isNull) {
    return null;
  }

  if (field.stringValue !== undefined) {
    return field.stringValue;
  }

  if (field.booleanValue !== undefined) {
    return field.booleanValue;
  }

  if (field.longValue !== undefined) {
    return field.longValue;
  }

  if (field.doubleValue !== undefined) {
    return field.doubleValue;
  }

  if (field.blobValue !== undefined) {
    return field.blobValue;
  }

  if (field.arrayValue !== undefined) {
    return field.arrayValue;
  }

  return null;
}

export function postgresPlaceholdersToNamed(sql: string) {
  return sql.replace(/\$(\d+)/g, (_match, index: string) => `:p${index}`);
}

function sqlParameters(values: readonly unknown[]): SqlParameter[] {
  return values.map((value, index) => valueToSqlParameter(`p${index + 1}`, value));
}

export async function dataApiQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  values: readonly unknown[] = []
): Promise<DataApiQueryResult<T>> {
  const env = getEnv();

  if (!env.DB_CLUSTER_ARN || !env.DB_SECRET_ARN) {
    throw new Error("DB_CLUSTER_ARN and DB_SECRET_ARN are required when DATABASE_DRIVER=data-api");
  }

  const response = await dataApi.send(
    new ExecuteStatementCommand({
      resourceArn: env.DB_CLUSTER_ARN,
      secretArn: env.DB_SECRET_ARN,
      database: env.DB_NAME,
      sql: postgresPlaceholdersToNamed(sql),
      parameters: sqlParameters(values),
      includeResultMetadata: true
    })
  );

  const columns = response.columnMetadata?.map((column) => column.label ?? column.name ?? "") ?? [];
  const rows = (response.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};

    record.forEach((field, index) => {
      const column = columns[index] || `column_${index + 1}`;
      row[column] = fieldToValue(field);
    });

    return row as T;
  });

  return {
    rows,
    rowCount: response.numberOfRecordsUpdated ?? rows.length
  };
}
