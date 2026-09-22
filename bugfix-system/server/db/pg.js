import pg from 'pg';
import { cfg } from '../config.js';

export const pool = new pg.Pool({ connectionString: cfg.databaseUrl });

export const q = (sql, params) => pool.query(sql, params);
export const one = async (sql, params) => (await q(sql, params)).rows[0] || null;
export const many = (sql, params) => q(sql, params).then((r) => r.rows);
