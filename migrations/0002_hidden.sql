-- 종료된 선거를 목록에서 숨기기(데이터는 그대로 두고 화면에서만 보이지 않게 함)
ALTER TABLE election ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
