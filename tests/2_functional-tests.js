'use strict';

const { randomUUID } = require('node:crypto');
const { assert } = require('chai');

suite('Functional Tests', function () {
  this.timeout(15000);

  const board = `test-${randomUUID()}`;
  const threads = `/api/threads/${board}`;
  const replies = `/api/replies/${board}`;
  const password = 'test-delete-password';

  let threadId;
  let replyId;

  function request(route, method = 'GET', body) {
    const port = process.env.MESSAGE_BOARD_TEST_PORT;
    const options = { method };

    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }

    return fetch(`http://127.0.0.1:${port}${route}`, options);
  }

  function createThread(text) {
    return request(threads, 'POST', { text, delete_password: password });
  }

  function createReply(text) {
    return request(replies, 'POST', {
      text,
      thread_id: threadId,
      delete_password: password,
    });
  }

  async function getThread() {
    const response = await request(`${replies}?thread_id=${threadId}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  function checkPrivateFields(record) {
    assert.notProperty(record, 'reported');
    assert.notProperty(record, 'delete_password');
  }

  test('Creating a new thread', async function () {
    const response = await createThread('First thread');
    const thread = await response.json();
    threadId = thread._id;

    assert.equal(response.status, 201);
    assert.isString(threadId);
    assert.equal(thread.text, 'First thread');
    assert.equal(thread.created_on, thread.bumped_on);
    assert.deepEqual(thread.replies, []);
    checkPrivateFields(thread);
  });

  test('Creating a new reply', async function () {
    const response = await createReply('First reply');
    const reply = await response.json();
    replyId = reply._id;
    const thread = await getThread();

    assert.equal(response.status, 201);
    assert.equal(thread.replies[0]._id, replyId);
    assert.equal(thread.replies[0].text, 'First reply');
    assert.equal(thread.bumped_on, reply.created_on);
    checkPrivateFields(reply);
  });

  test('Viewing the 10 most recent threads with 3 replies each', async function () {
    for (let i = 1; i <= 10; i++) {
      const response = await createThread(`Additional thread ${i}`);
      assert.equal(response.status, 201);
      await response.json();
    }

    for (let i = 2; i <= 4; i++) {
      const response = await createReply(`Reply ${i}`);
      assert.equal(response.status, 201);
      await response.json();
    }

    const response = await request(threads);
    const list = await response.json();
    const thread = list.find(item => item._id === threadId);

    assert.equal(response.status, 200);
    assert.lengthOf(list, 10);
    assert.equal(list[0]._id, threadId);
    assert.equal(thread.replycount, 4);
    assert.deepEqual(thread.replies.map(reply => reply.text), ['Reply 4', 'Reply 3', 'Reply 2']);
    checkPrivateFields(thread);
    thread.replies.forEach(checkPrivateFields);
  });

  test('Viewing a single thread with all replies', async function () {
    const thread = await getThread();

    assert.equal(thread._id, threadId);
    assert.lengthOf(thread.replies, 4);
    assert.equal(thread.replies[3]._id, replyId);
    checkPrivateFields(thread);
    thread.replies.forEach(checkPrivateFields);
  });

  test('Reporting a thread', async function () {
    const response = await request(threads, 'PUT', { thread_id: threadId });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'reported');
  });

  test('Reporting a reply', async function () {
    const response = await request(replies, 'PUT', {
      thread_id: threadId,
      reply_id: replyId,
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'reported');
  });

  test('Deleting a reply with the incorrect password', async function () {
    const response = await request(replies, 'DELETE', {
      thread_id: threadId,
      reply_id: replyId,
      delete_password: 'wrong',
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'incorrect password');
    const thread = await getThread();
    assert.equal(thread.replies.find(reply => reply._id === replyId).text, 'First reply');
  });

  test('Deleting a reply with the correct password', async function () {
    const response = await request(replies, 'DELETE', {
      thread_id: threadId,
      reply_id: replyId,
      delete_password: password,
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'success');
    const thread = await getThread();
    assert.equal(thread.replies.find(reply => reply._id === replyId).text, '[deleted]');
  });

  test('Deleting a thread with the incorrect password', async function () {
    const response = await request(threads, 'DELETE', {
      thread_id: threadId,
      delete_password: 'wrong',
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'incorrect password');
    const thread = await getThread();
    assert.equal(thread._id, threadId);
  });

  test('Deleting a thread with the correct password', async function () {
    const response = await request(threads, 'DELETE', {
      thread_id: threadId,
      delete_password: password,
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'success');

    const missing = await request(`${replies}?thread_id=${threadId}`);
    assert.equal(missing.status, 404);
  });
});