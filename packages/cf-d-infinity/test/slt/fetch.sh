#!/bin/sh
# SQLite の sqllogictest。https://github.com/gregrahn/sqllogictest のミラーから取得する。
cd "$(dirname "$0")"
for f in select1 select2 select3 select4 select5; do
  curl -sSfL -o "$f.test" "https://raw.githubusercontent.com/gregrahn/sqllogictest/master/test/$f.test"
done
# evidence、random、index は件数が多いので、取得済みのものをそのまま使う。
