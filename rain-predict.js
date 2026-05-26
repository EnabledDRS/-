/*
 * 강수예측 (Rain prediction)
 *
 * 알고리즘 출처: Rain predict.py (centroid 추적 + HSV 색→강수강도 매핑 + 외삽)
 * - 광학흐름(OpenCV.calcOpticalFlowFarneback) 대신 무게중심 변위만 사용.
 * - 픽셀 색상의 Hue 로 강수강도(mm/h)를 근사.
 * - 화면 중심 위치에 비구름이 도달하는 시점(분)과 그때의 강도를 외삽.
 */
(function () {
    'use strict';

    const PREDICTION_HORIZON_MIN = 60;   // 60분 앞까지 예측
    const MAX_HISTORY_FRAMES     = 12;   // 최근 12프레임 사용 (1시간 @ 5분)
    const TARGET_TOLERANCE_PX    = 4;    // 외삽 위치 ± 픽셀 여유

    // ────────────────────────────────────────────────────────────
    // DOM 핸들
    // ────────────────────────────────────────────────────────────
    const modeSelect  = document.getElementById('mode-select');
    const panel       = document.getElementById('rain-predict-panel');
    const summaryEl   = document.getElementById('rp-summary');
    const tbodyEl     = document.getElementById('rp-tbody');
    const refreshBtn  = document.getElementById('rp-refresh');

    if (!modeSelect || !panel) return;

    // 저장된 모드 복원
    const savedMode = localStorage.getItem('mode-select');
    if (savedMode) modeSelect.value = savedMode;
    panel.style.display = (modeSelect.value === 'rain-predict') ? '' : 'none';

    modeSelect.addEventListener('change', () => {
        localStorage.setItem('mode-select', modeSelect.value);
        if (modeSelect.value === 'rain-predict') {
            panel.style.display = '';
            tryRun();
        } else {
            panel.style.display = 'none';
        }
    });

    refreshBtn.addEventListener('click', tryRun);
    document.addEventListener('framesLoaded', () => {
        if (modeSelect.value === 'rain-predict') tryRun();
    });

    // ────────────────────────────────────────────────────────────
    // 픽셀 분석 헬퍼
    // ────────────────────────────────────────────────────────────

    /** ImageBitmap/Image 를 ImageData 로 변환. (CORS 실패 시 throw) */
    function imageToData(img) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return null;
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h);   // CORS 실패 시 SecurityError
    }

    /** RGB → HSV (OpenCV 컨벤션: H 0~179, S/V 0~255) */
    function rgbToHsv(r, g, b) {
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const v = max;
        const s = max === 0 ? 0 : Math.round((max - min) * 255 / max);
        let h;
        if (max === min)      h = 0;
        else if (max === r)   h = 30 * (((g - b) / (max - min)) % 6);
        else if (max === g)   h = 30 * ((b - r) / (max - min) + 2);
        else                  h = 30 * ((r - g) / (max - min) + 4);
        if (h < 0) h += 180;
        return [Math.round(h), s, v];
    }

    /** 한 프레임에서 강수 픽셀 마스크 + Hue → 강수강도(mm/h) 맵 + 무게중심 */
    function analyzeFrame(imageData) {
        const { data, width, height } = imageData;
        let sumX = 0, sumY = 0, count = 0;
        const intensity = new Float32Array(width * height);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const r = data[idx], g = data[idx+1], b = data[idx+2];
                // 빠른 사전 필터: 거의 흰 배경(채도 매우 낮음) 제외
                const maxC = Math.max(r,g,b), minC = Math.min(r,g,b);
                if (maxC - minC < 25) continue;       // 무채색
                if (maxC < 80)        continue;       // 너무 어두움(지도선)

                const [h] = rgbToHsv(r, g, b);
                // KMA C4 컬러맵: 파(약) → 녹 → 노(중) → 주/빨(강) → 보(극심)
                let mmh = 0;
                if      (h >= 90 && h <= 130)              mmh = 2.0;
                else if (h >= 60 && h <  90)               mmh = 5.0;
                else if (h >= 25 && h <  60)               mmh = 12.0;
                else if (h <  25 || h >  150)              mmh = 30.0;

                if (mmh > 0) {
                    intensity[y * width + x] = mmh;
                    sumX += x; sumY += y; count++;
                }
            }
        }
        if (count < 200) return null;
        return {
            cx: sumX / count, cy: sumY / count,
            intensity, width, height, count,
        };
    }

    /** 무게중심 시퀀스 → 가중평균 속도 (px/frame). 최근 변위에 지수가중. */
    function centroidVelocity(analyses) {
        const valid = analyses.filter(a => a !== null);
        if (valid.length < 2) return null;
        const dxs = [], dys = [];
        for (let i = 1; i < valid.length; i++) {
            dxs.push(valid[i].cx - valid[i-1].cx);
            dys.push(valid[i].cy - valid[i-1].cy);
        }
        const n = dxs.length;
        const w = new Array(n);
        let wsum = 0;
        for (let i = 0; i < n; i++) { w[i] = Math.exp(i / n); wsum += w[i]; }
        let vx = 0, vy = 0;
        for (let i = 0; i < n; i++) { vx += dxs[i] * w[i]; vy += dys[i] * w[i]; }
        vx /= wsum; vy /= wsum;
        // 방향 안정성
        const angs = dxs.map((dx, i) => Math.atan2(dys[i], dx));
        const mean = Math.atan2(
            angs.reduce((s, a) => s + Math.sin(a), 0) / n,
            angs.reduce((s, a) => s + Math.cos(a), 0) / n
        );
        const dev = Math.sqrt(angs.reduce((s, a) => {
            const d = Math.atan2(Math.sin(a - mean), Math.cos(a - mean));
            return s + d * d;
        }, 0) / n);
        const stability = Math.max(0, Math.min(1, 1 - dev / Math.PI));
        return { vx, vy, stability };
    }

    /** 외삽: 매 step 마다 (cx - k*vx, cy - k*vy) 픽셀의 강도를 채취. */
    function predictAtCenter(latest, vx, vy, intervalMin, horizonMin) {
        const { intensity, width, height } = latest;
        const cx = (width  / 2) | 0;
        const cy = (height / 2) | 0;
        const stepsMax = Math.floor(horizonMin / intervalMin);

        // 현재(0분) 중심부 강도
        let nowMax = 0;
        for (let dy = -5; dy <= 5; dy++) {
            for (let dx = -5; dx <= 5; dx++) {
                const xx = cx + dx, yy = cy + dy;
                if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
                const v = intensity[yy * width + xx];
                if (v > nowMax) nowMax = v;
            }
        }

        const rows = [];
        rows.push({ tMin: 0, mmh: nowMax });

        for (let step = 1; step <= stepsMax; step++) {
            const sx = Math.round(cx - step * vx);
            const sy = Math.round(cy - step * vy);
            let best = 0;
            const r = TARGET_TOLERANCE_PX;
            const x0 = Math.max(0, sx - r), x1 = Math.min(width,  sx + r + 1);
            const y0 = Math.max(0, sy - r), y1 = Math.min(height, sy + r + 1);
            if (x1 > x0 && y1 > y0) {
                for (let yy = y0; yy < y1; yy++) {
                    for (let xx = x0; xx < x1; xx++) {
                        const v = intensity[yy * width + xx];
                        if (v > best) best = v;
                    }
                }
            }
            rows.push({ tMin: step * intervalMin, mmh: best });
        }
        return rows;
    }

    function intensityLabel(mmh) {
        if (mmh < 1)  return ['없음',     '#666'];
        if (mmh < 5)  return ['약한 비',  '#3a7'];
        if (mmh < 15) return ['보통 비',  '#fc3'];
        if (mmh < 30) return ['강한 비',  '#f63'];
        return        ['매우 강한 비',    '#e22'];
    }

    function renderTable(rows, meta) {
        tbodyEl.innerHTML = '';
        let firstHit = null;
        rows.forEach((row, i) => {
            const tr = document.createElement('tr');
            const [lab, color] = intensityLabel(row.mmh);
            if (row.mmh > 0 && firstHit === null && i > 0) firstHit = row;
            tr.innerHTML =
                `<td>${row.tMin === 0 ? '현재' : '+' + row.tMin + '분'}</td>` +
                `<td>${row.mmh.toFixed(1)} mm/h</td>` +
                `<td style="color:${color}">${lab}</td>`;
            if (row.mmh > 0) tr.classList.add('rp-hit');
            tbodyEl.appendChild(tr);
        });

        const speedKmh = meta.speedPx * 0.25 * (60 / meta.intervalMin);  // 1px≈0.25km 근사
        let summary;
        if (rows[0].mmh > 0) {
            summary = `🌧 현재 비 내리는 중 (${rows[0].mmh.toFixed(1)} mm/h)`;
        } else if (firstHit) {
            summary = `🌥 약 ${firstHit.tMin}분 뒤 도달 예상 — ${intensityLabel(firstHit.mmh)[0]} (${firstHit.mmh.toFixed(1)} mm/h)`;
        } else {
            summary = `☀ 60분 내 도달 비구름 없음`;
        }
        summary += `<br><span class="rp-meta">비구름 속도 ~${speedKmh.toFixed(1)} km/h · 방향 안정성 ${(meta.stability*100).toFixed(0)}%</span>`;
        summaryEl.innerHTML = summary;
    }

    // ────────────────────────────────────────────────────────────
    // 메인 실행
    // ────────────────────────────────────────────────────────────
    async function tryRun() {
        const frames = window.bosaiFrames || [];
        const intervalMin = window.bosaiFrameIntervalMin || 5;
        if (!frames.length) {
            summaryEl.textContent = '아직 프레임이 로딩되지 않았습니다.';
            tbodyEl.innerHTML = '';
            return;
        }
        summaryEl.textContent = '분석 중…';
        tbodyEl.innerHTML = '';

        // 최근 N프레임만 사용. preloadedImages 순서: [0] = 가장 과거, [N-1] = 최신.
        const recent = frames.slice(-MAX_HISTORY_FRAMES);

        // 모든 이미지 로드 대기
        try {
            await Promise.all(recent.map(f => new Promise((res, rej) => {
                if (f.img.complete && f.img.naturalWidth > 0) return res();
                f.img.addEventListener('load',  () => res(), { once: true });
                f.img.addEventListener('error', () => rej(new Error('이미지 로드 실패')), { once: true });
            })));
        } catch (e) {
            summaryEl.textContent = '⚠ 일부 이미지 로드 실패: ' + e.message;
            return;
        }

        // 픽셀 분석
        let analyses;
        try {
            analyses = recent.map(f => analyzeFrame(imageToData(f.img)));
        } catch (e) {
            summaryEl.innerHTML =
                '⚠ 캔버스 분석 실패 (CORS).<br>' +
                '<span class="rp-meta">KMA 서버가 Access-Control-Allow-Origin 헤더를 보내지 않으면 ' +
                '브라우저에서 픽셀을 읽을 수 없습니다. 대안: 간단한 프록시 서버 경유 또는 로컬 캐시.</span>';
            console.error(e);
            return;
        }

        const motion = centroidVelocity(analyses);
        if (!motion) {
            summaryEl.textContent = '☀ 현재 화면에 분석 가능한 비구름 없음.';
            return;
        }

        // 최신 프레임 분석값에서 강도맵 추출
        const latest = analyses[analyses.length - 1] ||
                       analyses.filter(a => a !== null).slice(-1)[0];
        if (!latest) {
            summaryEl.textContent = '☀ 최신 프레임 비구름 없음.';
            return;
        }

        const speedPx = Math.hypot(motion.vx, motion.vy);
        if (speedPx < 0.5) {
            renderTable(
                [{ tMin: 0, mmh: latest.intensity[(latest.height/2|0) * latest.width + (latest.width/2|0)] }],
                { speedPx: 0, stability: motion.stability, intervalMin }
            );
            summaryEl.innerHTML = '⚠ 비구름이 거의 정지 상태 — 외삽 신뢰도 낮음.';
            return;
        }

        const rows = predictAtCenter(latest, motion.vx, motion.vy, intervalMin, PREDICTION_HORIZON_MIN);
        renderTable(rows, { speedPx, stability: motion.stability, intervalMin });
    }

    // 초기 시도 (이미 framesLoaded 가 이전에 발행됐을 수도 있으니)
    if (modeSelect.value === 'rain-predict' && window.bosaiFrames) {
        setTimeout(tryRun, 500);
    }
})();
