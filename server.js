'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST || '127.0.0.1';
const apiBase = 'https://api.jolpi.ca/ergast/f1/current';
const openF1Base = 'https://api.openf1.org/v1';
const rankingCache = new Map();
const cacheDuration = 5 * 60 * 1000;
const standingsCacheKey = 'standings:current';
const rankingEndpoints = {
    drivers: 'driverStandings',
    teams: 'constructorStandings'
};
const calendarCacheKey = 'calendar:current';
const resultsCache = new Map();
const openF1Cache = new Map();
let newsCache;
let openF1RequestQueue = Promise.resolve();
let nextOpenF1RequestAt = 0;
const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function sendJson(response, status, body) {
    response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(body));
}

function decodeXml(value) {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function rssText(item, tag) {
    const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match
        ? decodeXml(match[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
}

function directNewsLink(value) {
    try {
        const link = new URL(value);
        const destination = link.searchParams.get('url');
        const direct = destination ? new URL(destination) : link;
        if (!['http:', 'https:'].includes(direct.protocol)) return '';
        return direct.href;
    } catch {
        return '';
    }
}

function looksSpanish(text) {
    const words = new Set(text.toLocaleLowerCase('es').match(/[a-záéíóúüñ]+/g) || []);
    return [
        'de', 'la', 'el', 'en', 'y', 'del', 'los', 'las', 'por', 'para', 'con',
        'tras', 'así', 'hoy', 'una', 'sobre', 'desde', 'queda', 'equipo', 'piloto',
        'carrera', 'gran', 'premio', 'fórmula', 'formula', 'temporada', 'mundial',
        'gana', 'ganador', 'clasificación', 'vuelve', 'nuevo'
    ].some(word => words.has(word));
}

async function proxyNews(request, response) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Método no permitido.' });
        return;
    }

    if (newsCache && newsCache.expiresAt > Date.now()) {
        sendJson(response, 200, newsCache.payload);
        return;
    }

    try {
        const feedUrl = new URL('https://www.bing.com/news/search');
        feedUrl.searchParams.set('q', '"Fórmula 1"');
        feedUrl.searchParams.set('format', 'rss');
        feedUrl.searchParams.set('setlang', 'es-es');
        feedUrl.searchParams.set('cc', 'ES');
        const upstream = await fetch(feedUrl, {
            headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
            signal: AbortSignal.timeout(12000)
        });
        if (!upstream.ok) {
            throw new Error(`Bing News respondió HTTP ${upstream.status}.`);
        }

        const xml = await upstream.text();
        if (!xml.includes('<rss') || !xml.includes('<channel')) {
            throw new Error('Bing News devolvió un feed RSS no válido.');
        }
        const articles = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
            .map(([, item]) => {
                const title = rssText(item, 'title');
                const description = rssText(item, 'description');
                const source = rssText(item, 'News:Source') || rssText(item, 'source');
                const link = directNewsLink(rssText(item, 'link'));
                const publishedAt = rssText(item, 'pubDate');
                return { title, description, source, link, publishedAt };
            })
            .filter(article =>
                article.title &&
                article.description &&
                article.link &&
                looksSpanish(`${article.title} ${article.description}`)
            )
            .slice(0, 10);

        if (articles.length === 0) {
            throw new Error('El feed no contiene noticias en español con un enlace de origen válido.');
        }
        const payload = { provider: 'Bing News RSS · España', articles };
        newsCache = { payload, expiresAt: Date.now() + 10 * 60 * 1000 };
        sendJson(response, 200, payload);
    } catch (error) {
        console.error(`No se pudieron cargar las noticias RSS de F1: ${error.message}`);
        sendJson(response, 502, { error: error.message || 'No se pudieron cargar las noticias de F1.' });
    }
}

async function fetchJolpicaJson(url, description) {
    const upstream = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) {
        throw new Error(`Jolpica respondió HTTP ${upstream.status} al consultar ${description}.`);
    }

    const text = await upstream.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Jolpica devolvió JSON inválido al consultar ${description}.`);
    }
}

function winnerFromRace(race) {
    const winner = race?.Results?.find(result => result.position === '1');
    if (!winner?.Driver) return null;
    return {
        name: [winner.Driver.givenName, winner.Driver.familyName].filter(Boolean).join(' '),
        team: winner.Constructor?.name || '',
        fastestLap: winner.FastestLap?.Time?.time || '',
        season: Number(race.season),
        round: Number(race.round)
    };
}

function formatRaceTime(seconds) {
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const remainingSeconds = (milliseconds % 60000) / 1000;
    const formattedSeconds = remainingSeconds.toFixed(3).padStart(6, '0');
    return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${formattedSeconds}`
        : `${minutes}:${formattedSeconds}`;
}

function fetchOpenF1Json(url, description) {
    const scheduleRequest = () => {
        const scheduledRequest = openF1RequestQueue.then(async () => {
            const scheduledAt = Math.max(Date.now(), nextOpenF1RequestAt);
            nextOpenF1RequestAt = scheduledAt + 500;
            const delay = scheduledAt - Date.now();
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        });
        openF1RequestQueue = scheduledRequest.catch(() => {});
        return scheduledRequest;
    };

    const request = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await scheduleRequest();

            const upstream = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(15000)
            });
            if (upstream.status === 429 && attempt < 2) {
                await upstream.body?.cancel();
                const retryAfter = Number(upstream.headers.get('retry-after'));
                const backoff = Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : 1200 * (attempt + 1);
                await new Promise(resolve => setTimeout(resolve, backoff));
                continue;
            }
            if (!upstream.ok) {
                throw new Error(`OpenF1 respondió HTTP ${upstream.status} al consultar ${description}.`);
            }

            const text = await upstream.text();
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`OpenF1 devolvió JSON inválido al consultar ${description}.`);
            }
        }
        throw new Error(`OpenF1 mantuvo el límite de solicitudes al consultar ${description}.`);
    };
    return request();
}

async function proxyOpenF1Results(request, response, url) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Método no permitido.' });
        return;
    }

    const season = url.searchParams.get('season');
    const currentSeason = new Date().getUTCFullYear();
    if (!/^\d{4}$/.test(season || '') || Number(season) < 1950 || Number(season) > currentSeason) {
        sendJson(response, 400, { error: 'La temporada solicitada no es válida.' });
        return;
    }

    const cached = openF1Cache.get(season);
    if (cached && cached.expiresAt > Date.now()) {
        sendJson(response, 200, cached.payload);
        return;
    }

    try {
        const sessionsUrl = new URL(`${openF1Base}/sessions`);
        sessionsUrl.searchParams.set('year', season);
        sessionsUrl.searchParams.set('session_name', 'Race');
        const sessions = await fetchOpenF1Json(sessionsUrl, `las sesiones de carrera de ${season}`);
        if (!Array.isArray(sessions)) {
            throw new Error(`OpenF1 no devolvió sesiones de carrera válidas para ${season}.`);
        }

        const completedSessions = sessions
            .filter(session => !session.is_cancelled && Date.parse(session.date_end) <= Date.now())
            .sort((a, b) => a.date_start.localeCompare(b.date_start));
        const raceResults = await Promise.all(completedSessions.map(async session => {
            const sessionKey = encodeURIComponent(session.session_key);
            try {
                const sessionResults = await fetchOpenF1Json(
                    `${openF1Base}/session_result?session_key=${sessionKey}`,
                    `el resultado de la sesión ${sessionKey}`
                );
                if (!Array.isArray(sessionResults)) {
                    throw new Error(`OpenF1 devolvió un resultado no válido para la sesión ${sessionKey}.`);
                }
                const winner = sessionResults.find(result =>
                    Number(result.position) === 1 &&
                    result.driver_number !== null &&
                    result.driver_number !== undefined &&
                    Number.isFinite(Number(result.driver_number))
                );
                if (!winner) return null;

                const raceTimeSeconds = Number(winner.duration);
                const hasRaceTime = Number.isFinite(raceTimeSeconds) && raceTimeSeconds > 0;
                return {
                    date: session.date_start.slice(0, 10),
                    sessionKey: session.session_key,
                    winner: {
                        number: Number(winner.driver_number),
                        raceTime: hasRaceTime ? formatRaceTime(raceTimeSeconds) : '',
                        raceTimeSeconds: hasRaceTime ? raceTimeSeconds : null,
                        laps: Number(winner.number_of_laps) || null
                    }
                };
            } catch (error) {
                console.error(`No se pudieron cargar los datos OpenF1 de la sesión ${session.session_key}: ${error.message}`);
                return null;
            }
        }));

        const payload = {
            provider: 'OpenF1',
            season,
            results: raceResults.filter(Boolean)
        };
        openF1Cache.set(season, { payload, expiresAt: Date.now() + cacheDuration });
        sendJson(response, 200, payload);
    } catch (error) {
        console.error(`No se pudieron cargar los resultados OpenF1 de ${season}: ${error.message}`);
        sendJson(response, 502, { error: error.message || 'OpenF1 no está disponible.' });
    }
}

async function proxyRanking(request, response, url) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Método no permitido.' });
        return;
    }

    const endpoint = url.pathname.slice('/api/rankings/'.length);
    if (endpoint !== 'drivers' && endpoint !== 'teams') {
        sendJson(response, 404, { error: 'Clasificación no encontrada.' });
        return;
    }

    const cacheKey = endpoint;
    const cached = rankingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        sendJson(response, 200, cached.payload);
        return;
    }

    const upstreamUrl = new URL(`${apiBase}/${rankingEndpoints[endpoint]}/`);
    upstreamUrl.searchParams.set('limit', '5');

    try {
        const upstream = await fetch(upstreamUrl, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10000)
        });
        if (!upstream.ok) {
            console.error(`Jolpica respondió HTTP ${upstream.status} para ${endpoint}.`);
            sendJson(response, 502, { error: `Jolpica respondió HTTP ${upstream.status}.` });
            return;
        }

        const upstreamText = await upstream.text();
        let upstreamPayload;
        try {
            upstreamPayload = JSON.parse(upstreamText);
        } catch {
            console.error(`Jolpica devolvió JSON inválido para ${endpoint}.`);
            sendJson(response, 502, { error: 'Jolpica devolvió una respuesta que no es JSON válido.' });
            return;
        }

        const standings = upstreamPayload?.MRData?.StandingsTable?.StandingsLists?.[0];
        const rows = endpoint === 'drivers'
            ? standings?.DriverStandings
            : standings?.ConstructorStandings;
        if (!Array.isArray(rows) || rows.length === 0) {
            console.error(`Jolpica devolvió una respuesta no válida para ${endpoint}.`);
            sendJson(response, 502, { error: 'La respuesta de Jolpica no contiene una clasificación válida.' });
            return;
        }
        const rankingRows = rows.slice(0, 5).map(item => ({
            position: Number(item.position),
            name: endpoint === 'drivers'
                ? [item.Driver?.givenName, item.Driver?.familyName].filter(Boolean).join(' ')
                : item.Constructor?.name,
            team: endpoint === 'drivers' ? item.Constructors?.[0]?.name || '—' : undefined,
            points: Number(item.points)
        }));
        if (rankingRows.length !== 5 || rankingRows.some(item =>
            !Number.isFinite(item.position) || !item.name || !Number.isFinite(item.points)
        )) {
            console.error(`Jolpica devolvió posiciones incompletas para ${endpoint}.`);
            sendJson(response, 502, { error: 'La clasificación de Jolpica está incompleta.' });
            return;
        }
        const payload = {
            provider: 'Jolpica',
            season: standings.season,
            round: standings.round,
            rankings: rankingRows
        };
        rankingCache.set(cacheKey, { payload, expiresAt: Date.now() + cacheDuration });
        sendJson(response, 200, payload);
    } catch (error) {
        const message = error.name === 'TimeoutError'
            ? 'Jolpica excedió el tiempo de espera.'
            : 'No se pudo conectar con Jolpica.';
        console.error(`${message} (${endpoint}).`);
        sendJson(response, 502, { error: message });
    }
}

async function proxyStandings(request, response) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Método no permitido.' });
        return;
    }

    const cached = rankingCache.get(standingsCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        sendJson(response, 200, cached.payload);
        return;
    }

    try {
        const [driversPayload, constructorsPayload, lastRacePayload] = await Promise.all([
            fetchJolpicaJson(`${apiBase}/driverStandings.json?limit=100`, 'la clasificación de pilotos'),
            fetchJolpicaJson(`${apiBase}/constructorStandings.json?limit=100`, 'la clasificación de constructores'),
            fetchJolpicaJson(`${apiBase}/last/results.json?limit=100`, 'la parrilla del último Gran Premio')
        ]);
        const driverList = driversPayload?.MRData?.StandingsTable?.StandingsLists?.[0];
        const constructorList = constructorsPayload?.MRData?.StandingsTable?.StandingsLists?.[0];
        const latestRace = lastRacePayload?.MRData?.RaceTable?.Races?.[0];
        const standingsDrivers = driverList?.DriverStandings;
        const constructorStandings = constructorList?.ConstructorStandings;
        const latestResults = latestRace?.Results;
        if (
            !Array.isArray(standingsDrivers) || !standingsDrivers.length ||
            !Array.isArray(constructorStandings) || !constructorStandings.length ||
            !Array.isArray(latestResults) || !latestResults.length
        ) {
            throw new Error('Jolpica no devolvió las clasificaciones y la parrilla completas.');
        }

        const driversById = new Map(standingsDrivers.map(item => [item.Driver.driverId, {
            id: item.Driver.driverId,
            name: [item.Driver.givenName, item.Driver.familyName].filter(Boolean).join(' '),
            number: Number(item.Driver.permanentNumber) || null,
            nationality: item.Driver.nationality || '',
            position: Number(item.position),
            points: Number(item.points),
            wins: Number(item.wins),
            teamId: '',
            teamName: ''
        }]));
        const lineups = new Map();
        latestResults.forEach(result => {
            const driverId = result.Driver?.driverId;
            const teamId = result.Constructor?.constructorId;
            if (!driverId || !teamId) return;
            let driver = driversById.get(driverId);
            if (!driver) {
                driver = {
                    id: driverId,
                    name: [result.Driver.givenName, result.Driver.familyName].filter(Boolean).join(' '),
                    number: Number(result.Driver.permanentNumber) || null,
                    nationality: result.Driver.nationality || '',
                    position: null,
                    points: 0,
                    wins: 0,
                    teamId,
                    teamName: result.Constructor.name || ''
                };
                driversById.set(driverId, driver);
            }
            driver.teamId = teamId;
            driver.teamName = result.Constructor.name || '';
            if (!lineups.has(teamId)) lineups.set(teamId, []);
            lineups.get(teamId).push(driver);
        });

        const teams = constructorStandings.map(item => ({
            id: item.Constructor.constructorId,
            name: item.Constructor.name,
            shortName: item.Constructor.name,
            position: Number(item.position),
            points: Number(item.points),
            wins: Number(item.wins),
            drivers: (lineups.get(item.Constructor.constructorId) || [])
                .sort((a, b) => (a.position || Number.MAX_SAFE_INTEGER) - (b.position || Number.MAX_SAFE_INTEGER))
        }));
        const season = String(driverList.season || constructorList.season || new Date().getUTCFullYear());
        const round = Number(driverList.round || constructorList.round || 0);
        const drivers = [...driversById.values()]
            .filter(driver => driver.teamId)
            .sort((a, b) => (a.position || Number.MAX_SAFE_INTEGER) - (b.position || Number.MAX_SAFE_INTEGER));
        const payload = {
            provider: 'Jolpica',
            season,
            round,
            latestRace: latestRace.raceName,
            teams,
            drivers
        };
        rankingCache.set(standingsCacheKey, { payload, expiresAt: Date.now() + cacheDuration });
        sendJson(response, 200, payload);
    } catch (error) {
        console.error(`No se pudieron cargar las clasificaciones unificadas de Jolpica: ${error.message}`);
        sendJson(response, 502, { error: error.message || 'No se pudieron cargar las clasificaciones.' });
    }
}

async function proxyCalendar(request, response) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Método no permitido.' });
        return;
    }

    const cached = rankingCache.get(calendarCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        sendJson(response, 200, cached.payload);
        return;
    }

    try {
        const upstreamPayload = await fetchJolpicaJson(
            `${apiBase.replace(/\/current$/, '')}/current.json?limit=100`,
            'el calendario'
        );
        const raceTable = upstreamPayload?.MRData?.RaceTable;
        const sourceRaces = raceTable?.Races;
        if (!Array.isArray(sourceRaces) || sourceRaces.length === 0) {
            console.error('Jolpica devolvió un calendario vacío o con formato no válido.');
            sendJson(response, 502, { error: 'La respuesta de Jolpica no contiene carreras válidas.' });
            return;
        }

        const races = sourceRaces.map(race => ({
            round: Number(race.round),
            name: race.raceName,
            date: race.date,
            time: race.time || '',
            circuitId: race.Circuit?.circuitId || '',
            circuitName: race.Circuit?.circuitName || '',
            city: race.Circuit?.Location?.locality || '',
            country: race.Circuit?.Location?.country || '',
            latitude: Number(race.Circuit?.Location?.lat),
            longitude: Number(race.Circuit?.Location?.long),
            winner: null,
            lastWinner: null
        })).sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);

        if (races.some(race =>
            !Number.isInteger(race.round) ||
            !race.name ||
            !/^\d{4}-\d{2}-\d{2}$/.test(race.date) ||
            !Number.isFinite(Date.parse(`${race.date}T00:00:00Z`)) ||
            !race.circuitName
        )) {
            console.error('Jolpica devolvió una o más carreras incompletas.');
            sendJson(response, 502, { error: 'El calendario de Jolpica contiene carreras incompletas.' });
            return;
        }

        const season = String(raceTable.season || new Date().getUTCFullYear());
        const resultsKey = `winners:${season}`;
        let seasonResults = resultsCache.get(resultsKey);
        if (!seasonResults || seasonResults.expiresAt <= Date.now()) {
            try {
                const resultsPayload = await fetchJolpicaJson(
                    `${apiBase.replace(/\/current$/, '')}/${season}/results/1.json?limit=100`,
                    `los ganadores de ${season}`
                );
                const resultRaces = resultsPayload?.MRData?.RaceTable?.Races;
                if (!Array.isArray(resultRaces)) {
                    throw new Error(`Jolpica no devolvió resultados de carrera para ${season}.`);
                }
                seasonResults = {
                    races: resultRaces,
                    expiresAt: Date.now() + cacheDuration
                };
                resultsCache.set(resultsKey, seasonResults);
            } catch (error) {
                console.error(`No se pudieron cargar los ganadores de ${season}: ${error.message}`);
                seasonResults = { races: [], expiresAt: Date.now() + 30000 };
            }
        }

        const currentWinners = new Map(seasonResults.races.map(race => [
            Number(race.round),
            winnerFromRace(race)
        ]));
        races.forEach(race => {
            race.winner = currentWinners.get(race.round) || null;
        });

        const today = new Date().toISOString().slice(0, 10);
        const upcomingRaces = races.filter(race => race.date >= today && !race.winner);
        const circuitIds = [...new Set(upcomingRaces.map(race => race.circuitId).filter(Boolean))];
        await Promise.all(circuitIds.map(async circuitId => {
            const resultsKey = `circuit-winners:${circuitId}`;
            let circuitResults = resultsCache.get(resultsKey);
            if (!circuitResults || circuitResults.expiresAt <= Date.now()) {
                try {
                    const resultPayload = await fetchJolpicaJson(
                        `${apiBase.replace(/\/current$/, '')}/circuits/${encodeURIComponent(circuitId)}/results/1.json?limit=100`,
                        `el último ganador del circuito ${circuitId}`
                    );
                    const resultRaces = resultPayload?.MRData?.RaceTable?.Races;
                    if (!Array.isArray(resultRaces)) {
                        throw new Error(`Jolpica no devolvió resultados para el circuito ${circuitId}.`);
                    }
                    circuitResults = { races: resultRaces, expiresAt: Date.now() + cacheDuration };
                    resultsCache.set(resultsKey, circuitResults);
                } catch (error) {
                    console.error(`No se pudo cargar el ganador previo de ${circuitId}: ${error.message}`);
                    circuitResults = { races: [], expiresAt: Date.now() + 30000 };
                }
            }

            upcomingRaces.filter(race => race.circuitId === circuitId).forEach(race => {
                const previousRace = circuitResults.races
                    .filter(resultRace => resultRace.date < race.date)
                    .sort((a, b) => b.date.localeCompare(a.date))[0];
                race.lastWinner = winnerFromRace(previousRace);
            });
        }));

        const payload = {
            provider: 'Jolpica',
            season,
            races
        };
        rankingCache.set(calendarCacheKey, { payload, expiresAt: Date.now() + cacheDuration });
        sendJson(response, 200, payload);
    } catch (error) {
        const message = error.name === 'TimeoutError'
            ? 'Jolpica excedió el tiempo de espera al cargar el calendario.'
            : 'No se pudo conectar con Jolpica para cargar el calendario.';
        console.error(message);
        sendJson(response, 502, { error: message });
    }
}

function serveStatic(response, url) {
    let requestedPath;
    try {
        requestedPath = decodeURIComponent(url.pathname);
    } catch {
        response.writeHead(400);
        response.end('Solicitud inválida.');
        return;
    }

    const relativePath = requestedPath.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`) || !contentTypes[path.extname(filePath)]) {
        response.writeHead(404);
        response.end('No encontrado.');
        return;
    }

    fs.readFile(filePath, (error, contents) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            response.end(error.code === 'ENOENT' ? 'No encontrado.' : 'No se pudo leer el archivo.');
            return;
        }
        response.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Type': contentTypes[path.extname(filePath)],
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(contents);
    });
}

http.createServer((request, response) => {
    let url;
    try {
        url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
        response.writeHead(400);
        response.end('Solicitud inválida.');
        return;
    }

    if (url.pathname === '/api/calendar') {
        proxyCalendar(request, response);
        return;
    }
    if (url.pathname === '/api/news') {
        proxyNews(request, response);
        return;
    }
    if (url.pathname === '/api/openf1-results') {
        proxyOpenF1Results(request, response, url);
        return;
    }
    if (url.pathname === '/api/standings') {
        proxyStandings(request, response);
        return;
    }
    if (url.pathname.startsWith('/api/rankings/')) {
        proxyRanking(request, response, url);
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Endpoint no encontrado.' });
        return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405);
        response.end('Método no permitido.');
        return;
    }
    serveStatic(response, url);
}).listen(port, host, () => {
    console.log(`GridPosition disponible en http://${host}:${port}`);
});
