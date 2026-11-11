'use strict';

const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(resolve(process.env.DB || 'message-board.sqlite'));

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS threads (
    _id TEXT PRIMARY KEY,
    board TEXT NOT NULL,
    text TEXT NOT NULL,
    created_on TEXT NOT NULL,
    bumped_on TEXT NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0,
    delete_password TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS replies (
    _id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(_id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_on TEXT NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0,
    delete_password TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS threads_board_bumped
    ON threads (board, bumped_on DESC);

  CREATE INDEX IF NOT EXISTS replies_thread_created
    ON replies (thread_id, created_on DESC);
`);

const sql = {
  addThread: db.prepare(`
    INSERT INTO threads (_id, board, text, created_on, bumped_on, delete_password)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listThreads: db.prepare(`
    SELECT _id, text, created_on, bumped_on FROM threads
    WHERE board = ? ORDER BY bumped_on DESC, rowid DESC LIMIT 10
  `),
  findThread: db.prepare('SELECT * FROM threads WHERE board = ? AND _id = ?'),
  reportThread: db.prepare('UPDATE threads SET reported = 1 WHERE _id = ?'),
  deleteThread: db.prepare('DELETE FROM threads WHERE _id = ?'),
  bumpThread: db.prepare('UPDATE threads SET bumped_on = ? WHERE _id = ?'),
  addReply: db.prepare(`
    INSERT INTO replies (_id, thread_id, text, created_on, delete_password)
    VALUES (?, ?, ?, ?, ?)
  `),
  listReplies: db.prepare(`
    SELECT _id, text, created_on FROM replies
    WHERE thread_id = ? ORDER BY created_on DESC, rowid DESC LIMIT ?
  `),
  countReplies: db.prepare('SELECT COUNT(*) AS total FROM replies WHERE thread_id = ?'),
  findReply: db.prepare('SELECT * FROM replies WHERE thread_id = ? AND _id = ?'),
  reportReply: db.prepare('UPDATE replies SET reported = 1 WHERE _id = ?'),
  deleteReply: db.prepare("UPDATE replies SET text = '[deleted]' WHERE _id = ?"),
};

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${digest}`;
}

function matchesPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;

  const [salt, digest] = stored.split(':');
  const expected = Buffer.from(digest, 'hex');
  return timingSafeEqual(scryptSync(password, salt, expected.length), expected);
}

function validPost(text, password) {
  return typeof text === 'string' && text.trim().length > 0 &&
    text.length <= 10000 && typeof password === 'string' &&
    password.length > 0 && password.length <= 256;
}

function getThread(board, id) {
  return typeof id === 'string' ? sql.findThread.get(board, id) : undefined;
}

function getReply(board, threadId, replyId) {
  if (typeof replyId !== 'string' || !getThread(board, threadId)) return undefined;
  return sql.findReply.get(threadId, replyId);
}

function publicThread(thread, replyLimit = -1) {
  const { _id, text, created_on, bumped_on } = thread;
  return {
    _id,
    text,
    created_on,
    bumped_on,
    replies: sql.listReplies.all(_id, replyLimit),
    replycount: sql.countReplies.get(_id).total,
  };
}

function sendCreated(req, res, url, record) {
  if (req.get('accept')?.includes('text/html')) {
    return res.redirect(303, url);
  }

  return res.status(201).json(record);
}

module.exports = function (app) {
  app.param('board', (req, res, next, board) => {
    if (!/^[a-z0-9_-]{1,80}$/i.test(board)) {
      return res.status(400).type('text').send('invalid board');
    }
    next();
  });

  app.route('/api/threads/:board')
    .get((req, res) => {
      const threads = sql.listThreads.all(req.params.board);
      res.json(threads.map(thread => publicThread(thread, 3)));
    })
    .post((req, res) => {
      const { text, delete_password } = req.body;
      const { board } = req.params;

      if (!validPost(text, delete_password)) {
        return res.status(400).type('text').send('invalid text or password');
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      sql.addThread.run(id, board, text, now, now, hashPassword(delete_password));

      return sendCreated(req, res, `/b/${board}/`, publicThread(getThread(board, id)));
    })
    .put((req, res) => {
      const id = req.body.thread_id ?? req.body.report_id;
      const thread = getThread(req.params.board, id);

      if (!thread) return res.status(404).type('text').send('thread not found');
      sql.reportThread.run(thread._id);
      return res.type('text').send('reported');
    })
    .delete((req, res) => {
      const { thread_id, delete_password } = req.body;
      const thread = getThread(req.params.board, thread_id);

      if (!thread) return res.status(404).type('text').send('thread not found');
      if (!matchesPassword(delete_password, thread.delete_password)) {
        return res.type('text').send('incorrect password');
      }

      sql.deleteThread.run(thread._id);
      return res.type('text').send('success');
    });

  app.route('/api/replies/:board')
    .get((req, res) => {
      const thread = getThread(req.params.board, req.query.thread_id);
      if (!thread) return res.status(404).type('text').send('thread not found');
      return res.json(publicThread(thread));
    })
    .post((req, res, next) => {
      const { text, delete_password, thread_id } = req.body;
      const { board } = req.params;

      if (!validPost(text, delete_password)) {
        return res.status(400).type('text').send('invalid text or password');
      }

      const thread = getThread(board, thread_id);
      if (!thread) return res.status(404).type('text').send('thread not found');

      const id = randomUUID();
      const now = new Date().toISOString();
      const passwordHash = hashPassword(delete_password);

      db.exec('BEGIN');
      try {
        sql.addReply.run(id, thread_id, text, now, passwordHash);
        sql.bumpThread.run(now, thread_id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        return next(error);
      }

      return sendCreated(req, res, `/b/${board}/${thread_id}`, {
        _id: id,
        text,
        created_on: now,
      });
    })
    .put((req, res) => {
      const { thread_id, reply_id } = req.body;
      const reply = getReply(req.params.board, thread_id, reply_id);

      if (!reply) return res.status(404).type('text').send('reply not found');
      sql.reportReply.run(reply._id);
      return res.type('text').send('reported');
    })
    .delete((req, res) => {
      const { thread_id, reply_id, delete_password } = req.body;
      const reply = getReply(req.params.board, thread_id, reply_id);

      if (!reply) return res.status(404).type('text').send('reply not found');
      if (!matchesPassword(delete_password, reply.delete_password)) {
        return res.type('text').send('incorrect password');
      }

      sql.deleteReply.run(reply._id);
      return res.type('text').send('success');
    });
};