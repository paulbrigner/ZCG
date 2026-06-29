import {
  createAdapterFactory,
  type CleanedWhere,
  type CustomAdapter,
  type JoinConfig
} from "better-auth/adapters";
import { dataApiQuery } from "@/lib/data-api";

type SortBy = {
  field: string;
  direction: "asc" | "desc";
};

type QueryValue = string | number | boolean | string[] | number[] | Date | null;

function quoteIdentifier(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

function makeParams(values: QueryValue[], value: QueryValue) {
  values.push(value);
  return `$${values.length}`;
}

function whereToSql(where: CleanedWhere[] | undefined, values: QueryValue[]) {
  if (!where?.length) {
    return "";
  }

  const clauses = where.map((condition, index) => {
    const connector = index === 0 ? "" : condition.connector === "OR" ? " or " : " and ";
    const column = quoteIdentifier(condition.field);
    const value = condition.value;
    const insensitive = condition.mode === "insensitive" && typeof value === "string";
    const left = insensitive ? `lower(${column})` : column;
    const paramValue = insensitive ? value.toLowerCase() : value;

    if (value === null && condition.operator === "eq") {
      return `${connector}${column} is null`;
    }

    if (value === null && condition.operator === "ne") {
      return `${connector}${column} is not null`;
    }

    if (condition.operator === "in" || condition.operator === "not_in") {
      if (!Array.isArray(value)) {
        throw new Error(`${condition.operator} requires an array value`);
      }

      const params = value.map((entry) => makeParams(values, entry)).join(", ");
      return `${connector}${column} ${condition.operator === "in" ? "in" : "not in"} (${params})`;
    }

    if (condition.operator === "contains") {
      return `${connector}${left} like ${makeParams(values, `%${paramValue}%`)}`;
    }

    if (condition.operator === "starts_with") {
      return `${connector}${left} like ${makeParams(values, `${paramValue}%`)}`;
    }

    if (condition.operator === "ends_with") {
      return `${connector}${left} like ${makeParams(values, `%${paramValue}`)}`;
    }

    const operatorMap: Record<string, string> = {
      eq: "=",
      ne: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<="
    };

    return `${connector}${left} ${operatorMap[condition.operator] ?? "="} ${makeParams(values, paramValue)}`;
  });

  return ` where ${clauses.join("")}`;
}

function selectSql(select: string[] | undefined) {
  return select?.length ? select.map(quoteIdentifier).join(", ") : "*";
}

function assertNoJoin(join: JoinConfig | undefined) {
  if (join && Object.keys(join).length > 0) {
    throw new Error("Better Auth Data API adapter spike does not support joins yet");
  }
}

function returningSelect(select: string[] | undefined) {
  return select?.length ? select.map(quoteIdentifier).join(", ") : "*";
}

export const betterAuthDataApiAdapter = createAdapterFactory({
  config: {
    adapterId: "zcg-rds-data-api",
    adapterName: "ZCG RDS Data API Adapter",
    supportsJSON: true,
    supportsDates: true,
    supportsBooleans: true,
    supportsNumericIds: false,
    supportsUUIDs: false,
    transaction: false
  },
  adapter: (): CustomAdapter => ({
    async create<T extends Record<string, unknown>>({
      model,
      data,
      select
    }: {
      model: string;
      data: T;
      select?: string[];
    }) {
      const entries = Object.entries(data).filter(([, value]) => value !== undefined);
      const values: QueryValue[] = [];
      const columns = entries.map(([field]) => quoteIdentifier(field)).join(", ");
      const params = entries.map(([, value]) => makeParams(values, value as QueryValue)).join(", ");
      const sql = `insert into ${quoteIdentifier(model)} (${columns}) values (${params}) returning ${returningSelect(select)}`;
      const result = await dataApiQuery<T>(sql, values);

      if (!result.rows[0]) {
        throw new Error(`Better Auth Data API insert returned no row for ${model}`);
      }

      return result.rows[0];
    },

    async findOne<T>({
      model,
      where,
      select,
      join
    }: {
      model: string;
      where: CleanedWhere[];
      select?: string[];
      join?: JoinConfig;
    }) {
      assertNoJoin(join);
      const values: QueryValue[] = [];
      const result = await dataApiQuery<T & Record<string, unknown>>(
        `select ${selectSql(select)} from ${quoteIdentifier(model)}${whereToSql(where, values)} limit 1`,
        values
      );
      return (result.rows[0] as T | undefined) ?? null;
    },

    async findMany<T>({
      model,
      where,
      limit,
      select,
      sortBy,
      offset,
      join
    }: {
      model: string;
      where?: CleanedWhere[];
      limit: number;
      select?: string[];
      sortBy?: SortBy;
      offset?: number;
      join?: JoinConfig;
    }) {
      assertNoJoin(join);
      const values: QueryValue[] = [];
      const order = sortBy ? ` order by ${quoteIdentifier(sortBy.field)} ${sortBy.direction}` : "";
      const paging = ` limit ${Math.max(1, limit ?? 100)}${offset ? ` offset ${Math.max(0, offset)}` : ""}`;
      const result = await dataApiQuery<T & Record<string, unknown>>(
        `select ${selectSql(select)} from ${quoteIdentifier(model)}${whereToSql(where, values)}${order}${paging}`,
        values
      );
      return result.rows as T[];
    },

    async count({ model, where }: { model: string; where?: CleanedWhere[] }) {
      const values: QueryValue[] = [];
      const result = await dataApiQuery<{ count: number | string }>(
        `select count(*) as count from ${quoteIdentifier(model)}${whereToSql(where, values)}`,
        values
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async update<T>({
      model,
      where,
      update
    }: {
      model: string;
      where: CleanedWhere[];
      update: T;
    }) {
      if (!where.length) {
        return null;
      }

      const values: QueryValue[] = [];
      const updateRecord = update as Record<string, unknown>;
      const setSql = Object.entries(updateRecord)
        .filter(([, value]) => value !== undefined)
        .map(([field, value]) => `${quoteIdentifier(field)} = ${makeParams(values, value as QueryValue)}`)
        .join(", ");
      const result = await dataApiQuery<T & Record<string, unknown>>(
        `update ${quoteIdentifier(model)} set ${setSql}${whereToSql(where, values)} returning *`,
        values
      );
      return (result.rows[0] as T | undefined) ?? null;
    },

    async updateMany({
      model,
      where,
      update
    }: {
      model: string;
      where: CleanedWhere[];
      update: Record<string, unknown>;
    }) {
      if (!where.length) {
        return 0;
      }

      const values: QueryValue[] = [];
      const setSql = Object.entries(update)
        .filter(([, value]) => value !== undefined)
        .map(([field, value]) => `${quoteIdentifier(field)} = ${makeParams(values, value as QueryValue)}`)
        .join(", ");
      const result = await dataApiQuery(
        `update ${quoteIdentifier(model)} set ${setSql}${whereToSql(where, values)}`,
        values
      );
      return result.rowCount;
    },

    async delete({ model, where }: { model: string; where: CleanedWhere[] }) {
      if (!where.length) {
        return;
      }

      const values: QueryValue[] = [];
      await dataApiQuery(`delete from ${quoteIdentifier(model)}${whereToSql(where, values)}`, values);
    },

    async deleteMany({ model, where }: { model: string; where: CleanedWhere[] }) {
      if (!where.length) {
        return 0;
      }

      const values: QueryValue[] = [];
      const result = await dataApiQuery(
        `delete from ${quoteIdentifier(model)}${whereToSql(where, values)}`,
        values
      );
      return result.rowCount;
    },

    async consumeOne<T>({ model, where }: { model: string; where: CleanedWhere[] }) {
      if (!where.length) {
        return null;
      }

      const values: QueryValue[] = [];
      const result = await dataApiQuery<T & Record<string, unknown>>(
        `delete from ${quoteIdentifier(model)}
          where ctid in (
            select ctid
              from ${quoteIdentifier(model)}
              ${whereToSql(where, values)}
             limit 1
          )
          returning *`,
        values
      );
      return (result.rows[0] as T | undefined) ?? null;
    },

    async incrementOne<T>({
      model,
      where,
      increment,
      set
    }: {
      model: string;
      where: CleanedWhere[];
      increment: Record<string, number>;
      set?: Record<string, unknown>;
    }) {
      if (!where.length) {
        return null;
      }

      const values: QueryValue[] = [];
      const increments = Object.entries(increment).map(
        ([field, value]) => `${quoteIdentifier(field)} = ${quoteIdentifier(field)} + ${makeParams(values, value)}`
      );
      const sets = Object.entries(set ?? {}).map(
        ([field, value]) => `${quoteIdentifier(field)} = ${makeParams(values, value as QueryValue)}`
      );
      const result = await dataApiQuery<T & Record<string, unknown>>(
        `update ${quoteIdentifier(model)}
            set ${[...increments, ...sets].join(", ")}
          ${whereToSql(where, values)}
          returning *`,
        values
      );
      return (result.rows[0] as T | undefined) ?? null;
    }
  })
});
