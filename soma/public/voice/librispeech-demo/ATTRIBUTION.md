# LibriSpeech 示例片段的来源 / Sources of the LibriSpeech example clips

## 中文

这个目录里的 10 段声音是真人朗读的录音，取自 **LibriSpeech** 语料库的 dev-clean 子集（Panayotov, Chen, Povey & Khudanpur 2015，“LibriSpeech: an ASR corpus based on public domain audio books”，ICASSP 2015；https://www.openslr.org/12/ ，CC BY 4.0）。LibriSpeech 的录音来自 **LibriVox** 志愿者朗读的有声书，LibriVox 的录音属于公有领域。说话人只用 LibriSpeech 的编号标识，不写朗读者的名字。

每段的音素时间线来自 **LibriSpeech Alignments**（Loren Lugosch，Zenodo 2619474，https://zenodo.org/records/2619474 ，CC BY 4.0），是 Montreal Forced Aligner 的**自动对齐，不是人工标注**；边界没有逐个人工核对过。相关论文：Lugosch, Ravanelli, Ignoto, Tomar & Bengio (2019), Interspeech；McAuliffe, Socolof, Mihuc, Wagner & Sonderegger (2017), Interspeech。

本项目的改动：FLAC 解码、16 kHz 重采样到 24 kHz、剪掉首尾静音（各留 0.25 秒）、存成 16 位单声道 WAV；时间线减去剪掉的时长并换成 soma 的格式。性别取自 LibriSpeech 的 SPEAKERS.TXT。生成方法见 `soma/tools/voice/librispeech-demo.ts`。

- `ls-1272-135031-0020.wav` — 说话人 1272（男），章节 135031，语句 1272-135031-0020，4.27 秒；书：*Tik-Tok of Oz*（古登堡 #956）；转写：“I DON'T BELIEVE ANN KNEW ANY MAGIC OR SHE'D HAVE WORKED IT BEFORE”
- `ls-2035-147961-0020.wav` — 说话人 2035（女），章节 147961，语句 2035-147961-0020，3.55 秒；书：*My Antonia*（古登堡 #19810）；转写：“A BLACK DROVE CAME UP OVER THE HILL BEHIND THE WEDDING PARTY”
- `ls-2277-149897-0031.wav` — 说话人 2277（女），章节 149897，语句 2277-149897-0031，4.38 秒；书：*Sister Carrie*（古登堡 #5267）；转写：“HE TROUBLED OVER MANY LITTLE DETAILS AND TALKED PERFUNCTORILY TO EVERYBODY”
- `ls-3081-166546-0028.wav` — 说话人 3081（女），章节 166546，语句 3081-166546-0028，3.89 秒；书：*Initials Only*（古登堡 #1857）；转写：“IT WAS ONE WHICH GAVE ME A SMALL TRIUMPH OVER GEORGE”
- `ls-3536-8226-0030.wav` — 说话人 3536（女），章节 8226，语句 3536-8226-0030，4.05 秒；书：*He Knew He Was Right*（古登堡 #5140）；转写：“BUT IF YOU ASK ME MY OPINION WHY IN COURSE THEY'VE BEEN TOGETHER SOMEWHERE”
- `ls-3752-4944-0051.wav` — 说话人 3752（男），章节 4944，语句 3752-4944-0051，3.35 秒；书：*For the Term of His Natural Life*（古登堡 #3424）；转写：“THIS OF COURSE WAS MERE BRAVADO ON THE PART OF THE COMMANDANT”
- `ls-5536-43359-0006.wav` — 说话人 5536（男），章节 43359，语句 5536-43359-0006，4.06 秒；书：*The Soul of the Indian*（古登堡 #340）；转写：“THE FAMILY WAS NOT ONLY THE SOCIAL UNIT BUT ALSO THE UNIT OF GOVERNMENT”
- `ls-6241-61946-0017.wav` — 说话人 6241（男），章节 61946，语句 6241-61946-0017，4.30 秒；书：*A Journey to the Centre of the Earth*（古登堡 #18857）；转写：“TO RIDE OVER SALT WATER UPON THE BACK OF A LITTLE HORSE SEEMED TO ME ABSURD”
- `ls-6295-244435-0003.wav` — 说话人 6295（男），章节 244435，语句 6295-244435-0003，3.07 秒；书：*The Guns of Bull Run: A Story of the Civil War's Eve*（古登堡 #3653）；转写：“BOATS PUT OUT BOTH FROM THE FORT AND THE SHORE”
- `ls-6313-76958-0007.wav` — 说话人 6313（女），章节 76958，语句 6313-76958-0007，3.70 秒；书：*The Pony Rider Boys in Texas; Or, The Veiled Riddle of the Plains*（古登堡 #20087）；转写：“WE'VE GOT A HARD DRIVE BEFORE US AND EVERY MAN MUST BE FIT AS A FIDDLE”

## English

The 10 clips in this directory are recordings of real people reading aloud, taken from the dev-clean subset of the **LibriSpeech** corpus (Panayotov, Chen, Povey & Khudanpur 2015, “LibriSpeech: an ASR corpus based on public domain audio books”, ICASSP 2015; https://www.openslr.org/12/, CC BY 4.0). LibriSpeech is built from audiobooks read by **LibriVox** volunteers; LibriVox recordings are in the public domain. Speakers are identified by their LibriSpeech number only; readers' names are not given.

Each clip's phoneme timeline comes from **LibriSpeech Alignments** (Loren Lugosch, Zenodo 2619474, https://zenodo.org/records/2619474, CC BY 4.0): **automatic Montreal Forced Aligner alignments, not hand labels**; the boundaries have not been checked by hand. Papers: Lugosch, Ravanelli, Ignoto, Tomar & Bengio (2019), Interspeech; McAuliffe, Socolof, Mihuc, Wagner & Sonderegger (2017), Interspeech.

Changes made by this project: FLAC decoded, resampled from 16 kHz to 24 kHz, leading and trailing silence trimmed (0.25 s kept at each end), stored as 16-bit mono WAV; the timelines shifted by the trimmed time and converted to soma's format. Sex is taken from LibriSpeech's SPEAKERS.TXT. See `soma/tools/voice/librispeech-demo.ts` for how they were made.

- `ls-1272-135031-0020.wav` — speaker 1272 (male), chapter 135031, utterance 1272-135031-0020, 4.27 s; book: *Tik-Tok of Oz* (Gutenberg #956); transcript: “I DON'T BELIEVE ANN KNEW ANY MAGIC OR SHE'D HAVE WORKED IT BEFORE”
- `ls-2035-147961-0020.wav` — speaker 2035 (female), chapter 147961, utterance 2035-147961-0020, 3.55 s; book: *My Antonia* (Gutenberg #19810); transcript: “A BLACK DROVE CAME UP OVER THE HILL BEHIND THE WEDDING PARTY”
- `ls-2277-149897-0031.wav` — speaker 2277 (female), chapter 149897, utterance 2277-149897-0031, 4.38 s; book: *Sister Carrie* (Gutenberg #5267); transcript: “HE TROUBLED OVER MANY LITTLE DETAILS AND TALKED PERFUNCTORILY TO EVERYBODY”
- `ls-3081-166546-0028.wav` — speaker 3081 (female), chapter 166546, utterance 3081-166546-0028, 3.89 s; book: *Initials Only* (Gutenberg #1857); transcript: “IT WAS ONE WHICH GAVE ME A SMALL TRIUMPH OVER GEORGE”
- `ls-3536-8226-0030.wav` — speaker 3536 (female), chapter 8226, utterance 3536-8226-0030, 4.05 s; book: *He Knew He Was Right* (Gutenberg #5140); transcript: “BUT IF YOU ASK ME MY OPINION WHY IN COURSE THEY'VE BEEN TOGETHER SOMEWHERE”
- `ls-3752-4944-0051.wav` — speaker 3752 (male), chapter 4944, utterance 3752-4944-0051, 3.35 s; book: *For the Term of His Natural Life* (Gutenberg #3424); transcript: “THIS OF COURSE WAS MERE BRAVADO ON THE PART OF THE COMMANDANT”
- `ls-5536-43359-0006.wav` — speaker 5536 (male), chapter 43359, utterance 5536-43359-0006, 4.06 s; book: *The Soul of the Indian* (Gutenberg #340); transcript: “THE FAMILY WAS NOT ONLY THE SOCIAL UNIT BUT ALSO THE UNIT OF GOVERNMENT”
- `ls-6241-61946-0017.wav` — speaker 6241 (male), chapter 61946, utterance 6241-61946-0017, 4.30 s; book: *A Journey to the Centre of the Earth* (Gutenberg #18857); transcript: “TO RIDE OVER SALT WATER UPON THE BACK OF A LITTLE HORSE SEEMED TO ME ABSURD”
- `ls-6295-244435-0003.wav` — speaker 6295 (male), chapter 244435, utterance 6295-244435-0003, 3.07 s; book: *The Guns of Bull Run: A Story of the Civil War's Eve* (Gutenberg #3653); transcript: “BOATS PUT OUT BOTH FROM THE FORT AND THE SHORE”
- `ls-6313-76958-0007.wav` — speaker 6313 (female), chapter 76958, utterance 6313-76958-0007, 3.70 s; book: *The Pony Rider Boys in Texas; Or, The Veiled Riddle of the Plains* (Gutenberg #20087); transcript: “WE'VE GOT A HARD DRIVE BEFORE US AND EVERY MAN MUST BE FIT AS A FIDDLE”
