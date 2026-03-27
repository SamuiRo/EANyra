/**
 * src/teapot/database.js
 *
 * Sequelize singleton wrapper.
 * Storage path is now read from app.config.js (DB.storagePath) so the
 * whole project has one source of truth for path configuration.
 */

import { Sequelize } from 'sequelize';
import { DB }        from '../config/app.config.js';
import { print }     from '../shared/utils.js';

export class Database {
  /** @type {import('sequelize').Sequelize} */
  sequelize;

  #isConnected = false;

  constructor() {
    this.sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: DB.storagePath,
      logging: false,
      pool: {
        max:     5,
        min:     0,
        acquire: 30_000,
        idle:    10_000,
      },
      define: {
        freezeTableName: true,
        underscored:     false,
      },
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async connect() {
    if (this.#isConnected) {
      print('Database already connected.', 'warning');
      return;
    }
    try {
      await this.sequelize.authenticate();
      print(`Database connected: ${DB.storagePath}`, 'success');
      this.#isConnected = true;
    } catch (error) {
      print(`Unable to connect to database: ${error.message}`, 'error');
      throw error;
    }
  }

  async disconnect() {
    if (this.#isConnected) {
      await this.sequelize.close();
      this.#isConnected = false;
      print('Database connection closed.', 'system');
    }
  }

  get isConnected() {
    return this.#isConnected;
  }
}

const database = new Database();
export default database;