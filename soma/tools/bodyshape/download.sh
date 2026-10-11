#!/bin/bash
# 下载 tools/bodyshape 用到的调查数据到 data/raw/bodyshape/（不入库）。在 soma 项目根目录运行。
# Fetch the survey data used by tools/bodyshape into data/raw/bodyshape/ (gitignored).
# Run from the soma project root:  bash tools/bodyshape/download.sh
set -u
RAW=data/raw/bodyshape
mkdir -p "$RAW/ansur2" "$RAW/nhanes"
get() { [ -s "$2" ] || curl -sL -m 300 -o "$2" -w "%{http_code} %{size_download} $1\n" "$1"; }

# ANSUR II（美国陆军，2012）。官方页面的链接指向 tools.openlab.psu.edu/publicData/，该地址 2026 年已不再提供文件；
# 这里取互联网档案馆对同一 URL 的原样存档。
# ANSUR II (US Army 2012). The official links on https://www.openlab.psu.edu/ansur2/ point at
# tools.openlab.psu.edu/publicData/, which stopped serving the files (2026); the Internet
# Archive holds byte copies of those same URLs.
for s in FEMALE MALE; do
  get "https://web.archive.org/web/2023id_/http://tools.openlab.psu.edu/publicData/ANSUR_II_${s}_Public.csv" "$RAW/ansur2/ANSUR_II_${s}_Public.csv"
done

# NHANES 体格测量与人口学数据（CDC/NCHS，公有领域）。
# NHANES body measures + demographics (CDC/NCHS, public domain).
N=https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public
get $N/1999/DataFiles/BMX.xpt "$RAW/nhanes/BMX.xpt"
get $N/1999/DataFiles/DEMO.xpt "$RAW/nhanes/DEMO.xpt"
for p in 2001:B 2003:C 2005:D 2007:E 2009:F 2011:G 2013:H 2015:I 2017:J 2021:L; do
  y=${p%%:*}; l=${p##*:}
  get $N/$y/DataFiles/BMX_$l.xpt "$RAW/nhanes/BMX_$l.xpt"
  get $N/$y/DataFiles/DEMO_$l.xpt "$RAW/nhanes/DEMO_$l.xpt"
done
get $N/2017/DataFiles/P_BMX.xpt "$RAW/nhanes/P_BMX.xpt"
get $N/2017/DataFiles/P_DEMO.xpt "$RAW/nhanes/P_DEMO.xpt"
ls -la "$RAW/ansur2" "$RAW/nhanes"
