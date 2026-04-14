'use strict';

const { getDb } = require('../db/connection');

function getDbInstance() {
  return getDb();
}

function getByUserId(userId) {
  const db = getDbInstance();
  return db
    .prepare('SELECT * FROM application_profiles WHERE user_id = ?')
    .get(userId) || null;
}

function upsert(userId, data) {
  const db = getDbInstance();
  const stmt = db.prepare(
    `INSERT INTO application_profiles (
      user_id, full_name, email, phone, visa_status, work_rights,
      expected_salary, notice_period
    ) VALUES (
      @user_id, @full_name, @email, @phone, @visa_status, @work_rights,
      @expected_salary, @notice_period
    )
    ON CONFLICT(user_id) DO UPDATE SET
      full_name = @full_name,
      email = @email,
      phone = @phone,
      visa_status = @visa_status,
      work_rights = @work_rights,
      expected_salary = @expected_salary,
      notice_period = @notice_period,
      updated_at = CURRENT_TIMESTAMP`
  );
  const info = stmt.run({
    user_id: userId,
    full_name: data.full_name,
    email: data.email,
    phone: data.phone,
    visa_status: data.visa_status,
    work_rights: data.work_rights,
    expected_salary: data.expected_salary || null,
    notice_period: data.notice_period || null,
  });
  return info.changes;
}

module.exports = {
  getByUserId,
  upsert,
};
