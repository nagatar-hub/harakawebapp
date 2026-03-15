-- ジョブの強制停止機能サポート
-- process_pid: fork したプロセスのPIDを記録（kill用）
-- status に 'aborted' を追加
-- aborted_at: 中止日時

ALTER TABLE run
  ADD COLUMN process_pid INT,
  ADD COLUMN aborted_at TIMESTAMPTZ;

-- CHECK制約を再作成（'aborted' を追加）
ALTER TABLE run DROP CONSTRAINT IF EXISTS run_status_check;
ALTER TABLE run ADD CONSTRAINT run_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'aborted'));
