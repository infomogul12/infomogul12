-- 교회 로고(한 장). 관리자 화면과 투표 화면 왼쪽 위에 표시한다.
CREATE TABLE IF NOT EXISTS site_logo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mime TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
