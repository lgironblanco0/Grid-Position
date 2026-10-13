(() => {
    'use strict';

    const data = window.GRID_POSITION_DATA;
    const blog = window.GRID_POSITION_BLOG;
    if (!data) {
        document.querySelectorAll('.data-status, .calendar-summary').forEach(element => {
            element.textContent = 'No se pudieron cargar los datos locales.';
        });
        document.querySelectorAll('.next-race-label').forEach(element => {
            element.textContent = 'DATOS LOCALES NO DISPONIBLES';
        });
        return;
    }

    const byId = id => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const money = value => new Intl.NumberFormat('es-ES').format(Number(value) || 0);
    const localDate = value => new Intl.DateTimeFormat('es-ES', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    }).format(new Date(`${value}T00:00:00Z`));
    const link = (file, key, value) =>
        `${file}?${new URLSearchParams({ [key]: value })}`;
    const create = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    let currentTeams = [];
    let currentDrivers = [];
    let currentStandingsSeason = null;
    let currentStandingsPromise;
    let weatherRequestKey = '';
    let weatherAbortController;
    let weatherRefreshTimer;
    let calendarPromise;
    let nextScheduledRace = data.nextRace;
    let calendarSeason = data.season;
    let countdownInterval;
    let countdownRefreshRequested = false;
    const teamFor = id =>
        currentTeams.find(team => team.id === id) || data.teams.find(team => team.id === id);
    const driverFor = id =>
        currentDrivers.find(driver => driver.id === id) || data.drivers.find(driver => driver.id === id);
    const localToday = () => {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };

    function setNextRaceCountdown(race) {
        nextScheduledRace = race;
        countdownRefreshRequested = false;
        document.querySelectorAll('.next-race-label').forEach(label => {
            label.textContent = nextScheduledRace
                ? `PRÓXIMO GP: ${nextScheduledRace.name}`
                : `PRÓXIMO GP: SIN FECHAS FUTURAS EN EL CALENDARIO ${calendarSeason}`;
        });
        const timer = byId('countdown-timer');
        if (!timer) return;

        if (countdownInterval) window.clearInterval(countdownInterval);
        if (!nextScheduledRace?.startAt) {
            timer.textContent = 'SIN CARRERAS PRÓXIMAS';
            return;
        }

        const target = new Date(nextScheduledRace.startAt).getTime();
        if (!Number.isFinite(target)) {
            timer.textContent = 'FECHA POR CONFIRMAR';
            return;
        }
        const update = () => {
            const remaining = target - Date.now();
            if (remaining <= 0) {
                timer.textContent = 'EN CURSO / FINALIZADO';
                if (localToday() > nextScheduledRace.startAt.slice(0, 10) && !countdownRefreshRequested) {
                    countdownRefreshRequested = true;
                    loadGlobalCountdown();
                }
                return;
            }
            const days = Math.floor(remaining / 86400000);
            const hours = Math.floor((remaining % 86400000) / 3600000);
            const minutes = Math.floor((remaining % 3600000) / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            const pad = value => String(value).padStart(2, '0');
            timer.textContent = `${pad(days)}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
        };
        update();
        countdownInterval = window.setInterval(update, 1000);
    }

    function renderCountdown() {
        setNextRaceCountdown(nextScheduledRace);
    }

    function createBlogVisual(type, title, large = false) {
        const figure = create('figure', large ? 'blog-visual blog-visual-large' : 'blog-visual');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 640 240');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `Esquema visual: ${title}`);
        const titleElement = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        titleElement.textContent = `Esquema: ${title}`;
        svg.append(titleElement);
        const paths = {
            'open-wheel': 'M70 168 C120 168 120 112 180 112 L215 112 L240 78 L278 78 L300 112 L360 112 C400 112 410 150 455 150 L520 150',
            wing: 'M86 154 L172 154 L212 100 L430 100 L466 154 L548 154 M190 124 L454 124',
            'ground-effect': 'M82 154 C160 154 183 154 220 112 C255 72 330 72 366 112 C405 154 432 154 555 154',
            'power-unit': 'M82 130 L182 130 L214 94 L278 94 L308 130 L386 130 L424 100 L482 100 L530 130',
            tyre: 'M120 142 A58 58 0 1 1 236 142 A58 58 0 1 1 120 142 M404 142 A58 58 0 1 1 520 142 A58 58 0 1 1 404 142',
            brakes: 'M112 82 L212 82 L212 164 L112 164 Z M428 82 L528 82 L528 164 L428 164 Z M212 123 L428 123',
            safety: 'M110 164 L110 105 Q110 76 140 76 L390 76 Q428 76 428 112 L428 164 M192 78 Q266 20 342 78',
            'pit-stop': 'M86 154 L554 154 M126 104 L200 104 L200 154 M440 104 L514 104 L514 154 M222 124 L418 124'
        };
        const guide = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        guide.setAttribute('d', paths[type] || paths.wing);
        guide.setAttribute('fill', 'none');
        guide.setAttribute('stroke', 'currentColor');
        guide.setAttribute('stroke-width', type === 'tyre' ? '12' : '9');
        guide.setAttribute('stroke-linecap', 'round');
        guide.setAttribute('stroke-linejoin', 'round');
        svg.append(guide);

        const trackMarks = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        trackMarks.setAttribute('d', 'M40 204 H600 M40 36 H600');
        trackMarks.setAttribute('fill', 'none');
        trackMarks.setAttribute('stroke', 'rgba(255,255,255,.12)');
        trackMarks.setAttribute('stroke-width', '1');
        trackMarks.setAttribute('stroke-dasharray', '4 10');
        svg.append(trackMarks);
        figure.append(svg);
        const caption = create('figcaption', 'sr-only', `Ilustración esquemática: ${title}`);
        figure.append(caption);
        return figure;
    }

    function renderBlogCards(containerId, statusId, articles, section) {
        const container = byId(containerId);
        const status = byId(statusId);
        if (!container || !status) return;
        if (!Array.isArray(articles) || articles.length === 0) {
            status.textContent = 'No hay artículos locales disponibles en esta sección.';
            return;
        }
        const fragment = document.createDocumentFragment();
        articles.forEach(article => {
            const anchor = create('a', 'blog-card');
            anchor.href = `articulo.html?${new URLSearchParams({ seccion: section, id: article.id })}`;
            anchor.setAttribute('aria-label', `Leer artículo: ${article.title}`);
            anchor.append(
                createBlogVisual(article.visual, article.title),
                create('span', 'article-tag', article.category),
                create('h2', '', article.title),
                create('p', '', article.excerpt),
                create('span', 'blog-card-cta', 'Leer artículo completo →')
            );
            fragment.append(anchor);
        });
        container.replaceChildren(fragment);
        status.textContent = `${articles.length} artículos disponibles · contenido estático local.`;
    }

    function circuitArticles() {
        const specs = blog?.circuitSpecs || {};
        return data.circuits.map(circuit => {
            return {
                id: circuit.id,
                title: circuit.name,
                category: `CIRCUITO · ${circuit.city} · DESDE ${circuit.firstSeason}`,
                excerpt: circuit.history,
                visual: 'open-wheel'
            };
        });
    }

    function renderBlogArticle() {
        const content = byId('blog-article-content');
        if (!content) return;
        const section = params.get('seccion');
        const articleId = params.get('id');
        let article;
        let circuit;
        if (section === 'eras') article = blog?.eras.find(item => item.id === articleId);
        if (section === 'tecnica') article = blog?.technology.find(item => item.id === articleId);
        if (section === 'circuitos') {
            circuit = data.circuits.find(item => item.id === articleId);
            const specification = blog?.circuitSpecs[articleId];
            if (circuit && specification) {
                article = {
                    title: circuit.name,
                    category: `CIRCUITO · ${circuit.city} · ${circuit.country}`,
                    excerpt: circuit.history,
                    visual: 'open-wheel',
                    sections: [
                        { heading: 'Historia', body: `${circuit.history} El circuito figura en el archivo local desde ${circuit.firstSeason}.` },
                        { heading: 'Ficha del trazado', body: `Longitud: ${specification.length}. Número de curvas: ${specification.turns}. Esta ficha es una referencia estática del trazado y no se actualiza con cambios de configuración.` },
                        { heading: 'Curva o sección emblemática', body: specification.iconic },
                        { heading: 'Récord de vuelta de carrera', body: `${specification.record}, establecido por ${specification.holder}. Es una referencia histórica del diseño de pista asociado a este dato, no un récord en tiempo real.` }
                    ]
                };
            }
        }
        if (!article) {
            byId('blog-article-category').textContent = 'ARTÍCULO NO DISPONIBLE';
            byId('blog-article-title').textContent = 'No encontramos este artículo';
            byId('blog-article-intro').textContent = 'El enlace no corresponde a un contenido estático disponible.';
            byId('blog-article-status').textContent = 'Vuelve a una sección y elige una de sus tarjetas.';
            const back = byId('blog-back-link');
            back.href = section === 'tecnica' ? 'anatomia.html'
                : section === 'circuitos' ? 'circuitos.html' : 'eras.html';
            back.hidden = false;
            return;
        }

        byId('blog-article-category').textContent = article.category;
        byId('blog-article-title').textContent = article.title;
        byId('blog-article-intro').textContent = article.excerpt;
        byId('blog-article-status').hidden = true;
        const visual = byId('blog-article-visual');
        visual.replaceWith(createBlogVisual(article.visual, article.title, true));
        const sections = byId('blog-article-sections');
        const fragment = document.createDocumentFragment();
        article.sections.forEach(part => {
            const sectionElement = create('section', 'longform-section');
            sectionElement.append(create('h2', '', part.heading), create('p', '', part.body));
            fragment.append(sectionElement);
        });
        sections.replaceChildren(fragment);
        content.hidden = false;
        const back = byId('blog-back-link');
        back.href = section === 'tecnica' ? 'anatomia.html'
            : section === 'circuitos' ? 'circuitos.html' : 'eras.html';
        back.textContent = section === 'tecnica' ? '← Volver a Anatomía técnica'
            : section === 'circuitos' ? '← Volver a Circuitos' : '← Volver a Eras de la F1';
        back.hidden = false;
    }

    async function fetchJolpicaJson(resource, description) {
        const url = new URL(`https://api.jolpi.ca/ergast/f1/${resource}`);
        url.searchParams.set('_', String(Date.now()));
        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        });
        const responseText = await response.text();
        let payload;
        try {
            payload = JSON.parse(responseText);
        } catch {
            throw new Error(`Jolpica devolvió JSON inválido al consultar ${description}.`);
        }
        if (!response.ok) {
            throw new Error(`Jolpica respondió HTTP ${response.status} al consultar ${description}.`);
        }
        return payload;
    }

    function getCurrentCalendar() {
        if (!calendarPromise) {
            calendarPromise = (async () => {
                const payload = await fetchJolpicaJson('current.json?limit=100', 'el calendario');
                const raceTable = payload?.MRData?.RaceTable;
                const sourceRaces = raceTable?.Races;
                if (!Array.isArray(sourceRaces) || sourceRaces.length === 0) {
                    throw new Error('No se recibió un calendario de carreras válido.');
                }
                let resultsByRound = new Map();
                try {
                    const resultsPayload = await fetchJolpicaJson(
                        `${raceTable.season}/results/1.json?limit=100`,
                        `los resultados de ${raceTable.season}`
                    );
                    const resultRaces = resultsPayload?.MRData?.RaceTable?.Races;
                    if (Array.isArray(resultRaces)) {
                        resultsByRound = new Map(resultRaces.map(race => [Number(race.round), race]));
                    }
                } catch (error) {
                    console.error('No se pudieron añadir ganadores al calendario de Jolpica:', error);
                }

                const races = sourceRaces.map(race => {
                    const winner = resultsByRound.get(Number(race.round))
                        ?.Results?.find(result => result.position === '1');
                    return {
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
                        winner: winner ? {
                            name: [winner.Driver?.givenName, winner.Driver?.familyName].filter(Boolean).join(' '),
                            number: Number(winner.Driver?.permanentNumber) || null,
                            team: winner.Constructor?.name || '',
                            raceTime: winner.Time?.time || '',
                            fastestLap: winner.FastestLap?.Time?.time || '',
                            fastestLapNumber: Number(winner.FastestLap?.lap) || null,
                            season: Number(race.season),
                            round: Number(race.round)
                        } : null,
                        lastWinner: null
                    };
                }).sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);

                if (races.some(race =>
                    !Number.isInteger(race.round) ||
                    !race.name ||
                    !/^\d{4}-\d{2}-\d{2}$/.test(race.date) ||
                    !race.circuitName
                )) {
                    throw new Error('Jolpica devolvió carreras incompletas.');
                }
                return {
                    provider: 'Jolpica',
                    season: String(raceTable.season || new Date().getUTCFullYear()),
                    races
                };
            })().catch(error => {
                calendarPromise = null;
                throw error;
            });
        }
        return calendarPromise;
    }

    async function loadGlobalCountdown() {
        try {
            const payload = await getCurrentCalendar();
            const now = Date.now();
            const nextRace = payload.races
                .map(race => ({
                    name: race.name,
                    startAt: `${race.date}T${race.time || '00:00:00Z'}`
                }))
                .filter(race => Number.isFinite(Date.parse(race.startAt)) && Date.parse(race.startAt) > now)
                .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0];
            calendarSeason = payload.season;
            setNextRaceCountdown(nextRace || null);
        } catch (error) {
            console.error('No se pudo actualizar el contador global con el calendario oficial:', error);
            document.querySelectorAll('.next-race-label').forEach(label => {
                label.textContent = 'CALENDARIO NO DISPONIBLE';
            });
            const timer = byId('countdown-timer');
            if (timer) timer.textContent = '—';
        }
    }

    function renderRankingRows(body, entries, includeTeam) {
        const fragment = document.createDocumentFragment();
        entries.slice(0, 5).forEach(entry => {
            const row = create('tr');
            const values = [String(entry.position), entry.name];
            if (includeTeam) values.push(entry.team || '—');
            values.push(money(entry.points));
            values.forEach((value, index) => {
                const cell = create('td');
                cell.textContent = value;
                row.append(cell);
            });
            fragment.append(row);
        });
        body.replaceChildren(fragment);
    }

    function renderHomeRankings() {
        const driverFallback = data.drivers.slice().sort((a, b) => a.position - b.position)
            .slice(0, 5).map(driver => ({
                position: driver.position,
                name: driver.name,
                team: teamFor(driver.team)?.shortName || '—',
                points: driver.points
            }));
        const teamFallback = data.teams.slice().sort((a, b) => a.position - b.position)
            .slice(0, 5).map(team => ({
                position: team.position,
                name: team.shortName,
                points: team.points
            }));
        if (byId('driver-top-five')) renderRankingRows(byId('driver-top-five'), driverFallback, true);
        if (byId('team-top-five')) renderRankingRows(byId('team-top-five'), teamFallback, false);
        loadCurrentStandings();
    }

    function applyCurrentStandings(payload) {
        const localTeams = new Map(data.teams.map(team => [team.id, team]));
        currentStandingsSeason = Number(payload.season) || data.season;
        currentDrivers = payload.drivers.map(driver => {
            const localDriver = data.drivers.find(item => item.id === driver.id);
            return {
                ...driver,
                team: driver.teamId,
                country: driver.nationality || '',
                bio: localDriver?.bio || `Piloto de ${driver.teamName || 'Fórmula 1'} en la temporada ${payload.season}.`
            };
        });
        const driversById = new Map(currentDrivers.map(driver => [driver.id, driver]));
        currentTeams = payload.teams.map(team => {
            const localTeam = localTeams.get(team.id);
            return {
                ...team,
                color: localTeam?.color || '#71717A',
                base: localTeam?.base || 'Base no disponible en la clasificación',
                car: '',
                drivers: team.drivers.map(driver => driver.id).filter(id => driversById.has(id))
            };
        }).sort((a, b) => a.position - b.position);
        currentDrivers.sort((a, b) => a.position - b.position);

        const driverBody = byId('driver-top-five');
        if (driverBody) {
            renderRankingRows(driverBody, currentDrivers.slice(0, 5).map(driver => ({
                position: driver.position,
                name: driver.name,
                team: currentTeams.find(team => team.id === driver.teamId)?.shortName || '—',
                points: driver.points
            })), true);
            byId('drivers-ranking-status').textContent =
                `Clasificación Jolpica · temporada ${payload.season}, ronda ${payload.round}.`;
        }
        const teamBody = byId('team-top-five');
        if (teamBody) {
            renderRankingRows(teamBody, currentTeams.slice(0, 5), false);
            byId('teams-ranking-status').textContent =
                `Clasificación Jolpica · temporada ${payload.season}, ronda ${payload.round}.`;
        }
        const teamStatus = byId('team-status');
        if (teamStatus) {
            teamStatus.textContent =
                `Clasificación Jolpica · temporada ${payload.season}, ronda ${payload.round}. Pilotos vinculados a la parrilla de ${payload.latestRace}.`;
        }
        if (byId('team-list')) renderTeams(false);
        if (byId('team-detail')) renderTeamDetail();
        if (byId('driver-detail')) renderDriverDetail();
    }

    function loadCurrentStandings() {
        if (currentStandingsPromise || !(
            byId('driver-top-five') || byId('team-top-five') ||
            byId('team-list') || byId('team-detail') || byId('driver-detail')
        )) return currentStandingsPromise;

        if (!currentStandingsPromise) {
            currentStandingsPromise = (async () => {
                try {
                    const [driversPayload, constructorsPayload, latestRacePayload] = await Promise.all([
                        fetchJolpicaJson('current/driverStandings.json?limit=100', 'la clasificación de pilotos'),
                        fetchJolpicaJson('current/constructorStandings.json?limit=100', 'la clasificación de constructores'),
                        fetchJolpicaJson('current/last/results.json?limit=100', 'la parrilla del último Gran Premio')
                    ]);
                    const driverList = driversPayload?.MRData?.StandingsTable?.StandingsLists?.[0];
                    const constructorList = constructorsPayload?.MRData?.StandingsTable?.StandingsLists?.[0];
                    const latestRace = latestRacePayload?.MRData?.RaceTable?.Races?.[0];
                    const standingsDrivers = driverList?.DriverStandings;
                    const constructorStandings = constructorList?.ConstructorStandings;
                    const latestResults = latestRace?.Results;
                    if (!Array.isArray(standingsDrivers) || !standingsDrivers.length ||
                        !Array.isArray(constructorStandings) || !constructorStandings.length ||
                        !Array.isArray(latestResults) || !latestResults.length) {
                        throw new Error('Jolpica devolvió clasificaciones o una parrilla incompletas.');
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
                    const payload = {
                        provider: 'Jolpica',
                        season: String(driverList.season || constructorList.season || new Date().getUTCFullYear()),
                        round: Number(driverList.round || constructorList.round || 0),
                        latestRace: latestRace.raceName,
                        teams,
                        drivers: [...driversById.values()]
                            .filter(driver => driver.teamId)
                            .sort((a, b) => (a.position || Number.MAX_SAFE_INTEGER) - (b.position || Number.MAX_SAFE_INTEGER))
                    };
                    applyCurrentStandings(payload);
                } catch (error) {
                    console.error('No se pudieron cargar las clasificaciones actuales de Jolpica:', error);
                    ['drivers-ranking-status', 'teams-ranking-status'].forEach(id => {
                        const status = byId(id);
                        if (status) status.textContent =
                            `Jolpica no disponible (${error.message}). Se conserva el respaldo local ${data.season}.`;
                    });
                    const teamStatus = byId('team-status');
                    if (teamStatus) teamStatus.textContent =
                        `${data.dataLabel} · respaldo local; no se pudo actualizar la parrilla actual.`;
                }
            })();
        }
        return currentStandingsPromise;
    }

    function makeTeamCard(team) {
        const card = create('article', 'team-card');
        card.style.setProperty('--team-color', team.color);
        const heading = create('div', 'team-card-heading');
        const identity = create('div');
        identity.className = 'team-card-identity';
        const title = create('h2');
        const teamLink = create('a', '', team.name);
        teamLink.href = link('equipo.html', 'equipo', team.id);
        title.append(teamLink);
        identity.append(title, create('p', 'team-base', team.base));
        heading.append(identity, create('span', 'points-badge', `PTS: ${money(team.points)}`));
        const roster = create('ul', 'team-driver-list');

        team.drivers.map(driver => typeof driver === 'string' ? driverFor(driver) : driver)
            .filter(Boolean).forEach(driver => {
            const standing = create('li');
            const row = create('div', 'team-driver-main');
            const driverLink = create('a', '', `${driver.name} (#${driver.number})`);
            driverLink.href = link('piloto.html', 'piloto', driver.id);
            row.append(driverLink, create('span', 'driver-points', `${money(driver.points)} pts`));
            standing.append(row, create('p', 'driver-meta', `P${driver.position} · ${driver.wins} victorias`));
            roster.append(standing);
        });

        card.append(heading, roster);
        return card;
    }

    function renderTeams(loadLive = true) {
        const container = byId('team-list');
        if (!container) return;
        const fragment = document.createDocumentFragment();
        (currentTeams.length ? currentTeams : data.teams).slice().sort((a, b) => a.position - b.position)
            .forEach(team => fragment.append(makeTeamCard(team)));
        container.replaceChildren(fragment);
        const status = byId('team-status');
        if (status && !currentTeams.length) status.textContent = `${data.dataLabel} · ${data.teams.length} escuderías.`;
        if (loadLive) loadCurrentStandings();
    }

    function renderTeamDetail() {
        const container = byId('team-detail');
        if (!container) return;
        const team = teamFor(params.get('equipo'));
        if (!team) {
            byId('team-title').textContent = 'ESCUDERÍA';
            byId('team-detail-status').textContent =
                'Abre una escudería desde la lista para consultar sus datos locales.';
            container.replaceChildren();
            return;
        }

        byId('team-title').textContent = team.name;
        container.style.setProperty('--team-color', team.color);
        const facts = create('dl', 'spec-list');
        [
            ['Temporada', String(currentStandingsSeason || data.season)],
            ['Posición', `P${team.position}`],
            ['Puntos', money(team.points)],
            ['Victorias', String(team.wins)],
            ['Base', team.base],
            ['Monoplaza', team.car || 'No disponible']
        ].forEach(([termText, descriptionText]) => {
            facts.append(create('dt', '', termText), create('dd', '', descriptionText));
        });

        const roster = create('ul', 'roster-grid');
        team.drivers.map(driver => typeof driver === 'string' ? driverFor(driver) : driver)
            .filter(Boolean).forEach(driver => {
            const item = create('li', 'roster-card');
            item.append(create('span', 'entity-kicker', `P${driver.position} · ${money(driver.points)} PTS`));
            const heading = create('h3');
            const anchor = create('a', '', driver.name);
            anchor.href = link('piloto.html', 'piloto', driver.id);
            heading.append(anchor);
            item.append(
                heading,
                create('p', 'roster-meta', `Dorsal #${driver.number} · ${driver.nationality} · ${driver.wins} victorias`)
            );
            roster.append(item);
        });

        const carPanel = byId('team-car-info');
        const rosterPanel = byId('team-roster');
        const specNote = team.car
            ? `Modelo registrado en el archivo de ${data.season}: ${team.car}. Es una ficha estática, no una especificación técnica actualizada.`
            : `Posición y puntos corresponden a la clasificación actual de Jolpica ${currentStandingsSeason}; el monoplaza y la base no están incluidos en esa fuente.`;
        carPanel.replaceChildren(facts, create(
            'p',
            'data-note',
            specNote
        ));
        rosterPanel.replaceChildren(roster);
        byId('team-detail-status').textContent = currentTeams.length
            ? `Clasificación Jolpica · temporada ${currentStandingsSeason} · pilotos de la parrilla de la última carrera.`
            : `${data.dataLabel} · ficha local de ${team.shortName}.`;
    }

    function renderDriverDetail() {
        const container = byId('driver-detail');
        if (!container) return;
        const historicalDriver = data.historicalChampions.find(item =>
            item.id === params.get('piloto')
        );
        const driver = driverFor(params.get('piloto')) || historicalDriver;
        if (!driver) {
            byId('driver-title').textContent = 'PILOTO';
            byId('driver-status').textContent =
                'Abre un piloto desde la clasificación o una escudería para ver su ficha local.';
            return;
        }
        const team = teamFor(driver.team);
        byId('driver-title').textContent = driver.name;
        byId('driver-country').textContent = driver.country;
        byId('driver-number').textContent = `#${driver.number}`;
        if (historicalDriver) {
            byId('driver-number').textContent = 'Piloto histórico';
            byId('driver-season-position').textContent = '—';
            byId('driver-season-points').textContent = '—';
            byId('driver-season-wins').textContent = `${driver.titles} títulos mundiales`;
            byId('driver-position').textContent = `Campeón en ${driver.years}`;
            byId('driver-lap').textContent = 'Ficha biográfica histórica';
        } else {
            byId('driver-season-position').textContent = `P${driver.position}`;
            byId('driver-season-points').textContent = `${money(driver.points)} pts`;
            byId('driver-season-wins').textContent = String(driver.wins);
            byId('driver-position').textContent = `Clasificación de la temporada ${currentStandingsSeason || data.season}`;
            byId('driver-lap').textContent = 'Tiempos por vuelta no incluidos en este archivo local';
        }
        const teamLink = byId('driver-team-link');
        teamLink.textContent = team?.name || 'Escudería no disponible';
        if (team) {
            teamLink.href = link('equipo.html', 'equipo', team.id);
        } else if (historicalDriver) {
            teamLink.href = 'eras.html#campeones';
            teamLink.textContent = 'Volver a campeones históricos';
        }
        byId('driver-status').textContent = currentStandingsSeason
            ? `Clasificación Jolpica · temporada ${currentStandingsSeason}.`
            : `${data.dataLabel} · biografía breve y resultados de temporada.`;
        if (!currentStandingsPromise) loadCurrentStandings();
        const bio = byId('driver-bio');
        if (bio) bio.textContent = driver.bio;
    }

    function weatherDescription(code) {
        if (code === 0) return ['☀', 'Despejado'];
        if ([1, 2].includes(code)) return ['◐', 'Parcialmente nublado'];
        if (code === 3) return ['☁', 'Nublado'];
        if ([45, 48].includes(code)) return ['≋', 'Niebla'];
        if ([51, 53, 55, 56, 57].includes(code)) return ['⟋', 'Llovizna'];
        if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return ['☂', 'Lluvia'];
        if ([71, 73, 75, 77, 85, 86].includes(code)) return ['❄', 'Nieve'];
        if ([95, 96, 99].includes(code)) return ['⚡', 'Tormenta'];
        return ['—', 'Estado no disponible'];
    }

    function setWeatherMessage(raceName, message, statusText) {
        const race = byId('weather-race');
        const forecast = byId('weather-forecast');
        if (race) race.textContent = raceName;
        if (forecast) forecast.hidden = true;
        const description = byId('weather-description');
        if (description) description.textContent = message;
        const status = byId('weather-status');
        if (status) status.textContent = statusText;
    }

    function renderWeatherForecast(race, daily, savedAt) {
        const index = daily.time.indexOf(race.date);
        if (index < 0) throw new Error('Open-Meteo no incluyó la fecha de esta carrera.');

        const [icon, description] = weatherDescription(Number(daily.weather_code[index]));
        const formatMetric = (value, suffix) =>
            value !== null && value !== undefined && Number.isFinite(Number(value))
                ? `${Math.round(Number(value))}${suffix}`
                : '—';
        const setText = (id, value) => {
            const element = byId(id);
            if (element) element.textContent = value;
        };
        setText('weather-icon', icon);
        setText('weather-description', description);
        setText('weather-max', formatMetric(daily.temperature_2m_max[index], '°'));
        setText('weather-min', formatMetric(daily.temperature_2m_min[index], '°'));
        setText('weather-rain', formatMetric(daily.precipitation_probability_max[index], '%'));
        setText('weather-wind', formatMetric(daily.wind_speed_10m_max[index], ' km/h'));
        const forecast = byId('weather-forecast');
        if (forecast) forecast.hidden = false;
        const status = byId('weather-status');
        if (status) {
            status.textContent = savedAt
                ? `RESPALDO · ${new Date(savedAt).toLocaleString('es-ES')}`
                : 'PRONÓSTICO · OPEN-METEO';
        }
    }

    function scheduleWeatherRefresh(races, season) {
        if (weatherRefreshTimer) window.clearTimeout(weatherRefreshTimer);
        const now = new Date();
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        weatherRefreshTimer = window.setTimeout(
            () => updateWeatherForecast(races, season),
            nextMidnight.getTime() - now.getTime() + 1000
        );
    }

    async function updateWeatherForecast(races, season) {
        const today = localToday();
        const orderedRaces = races.slice().sort((a, b) => a.date.localeCompare(b.date));
        let nextRace = orderedRaces.find(race => race.date >= today);
        try {
            const storedTarget = JSON.parse(localStorage.getItem('gridposition-weather-target') || 'null');
            if (storedTarget?.season === season && storedTarget.date === today) {
                nextRace = orderedRaces.find(race => race.date === storedTarget.date) || nextRace;
            }
        } catch (error) {
            console.error('No se pudo leer la carrera guardada para el panel del clima:', error);
        }

        if (!nextRace) {
            weatherRequestKey = '';
            setWeatherMessage('No hay Grandes Premios pendientes.', 'La temporada ha finalizado.', 'SIN CARRERAS FUTURAS');
            scheduleWeatherRefresh(races, season);
            return;
        }

        try {
            localStorage.setItem('gridposition-weather-target', JSON.stringify({
                season,
                date: nextRace.date,
                name: nextRace.name
            }));
        } catch (error) {
            console.error('No se pudo guardar el Gran Premio seleccionado para el clima:', error);
        }

        const raceLocation = [nextRace.city, nextRace.country].filter(Boolean).join(', ');
        const raceLabel = `${nextRace.name}${raceLocation ? ` · ${raceLocation}` : ''} · ${localDate(nextRace.date)}`;
        if (!Number.isFinite(nextRace.latitude) || !Number.isFinite(nextRace.longitude)) {
            weatherRequestKey = '';
            setWeatherMessage(raceLabel, 'No hay coordenadas del circuito para consultar Open-Meteo.', 'UBICACIÓN NO DISPONIBLE');
            scheduleWeatherRefresh(races, season);
            return;
        }

        const daysUntilRace = Math.floor(
            (Date.parse(`${nextRace.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000
        );
        if (daysUntilRace > 16) {
            weatherRequestKey = '';
            setWeatherMessage(
                raceLabel,
                `El pronóstico diario estará disponible en Open-Meteo dentro de ${daysUntilRace - 16} días.`,
                'FUERA DE VENTANA METEOROLÓGICA'
            );
            scheduleWeatherRefresh(races, season);
            return;
        }

        const targetKey = `${season}:${nextRace.date}:${today}:${nextRace.latitude}:${nextRace.longitude}`;
        if (weatherRequestKey === targetKey) {
            scheduleWeatherRefresh(races, season);
            return;
        }
        weatherRequestKey = targetKey;
        if (weatherAbortController) weatherAbortController.abort();
        weatherAbortController = new AbortController();
        setWeatherMessage(raceLabel, 'Consultando Open-Meteo…', 'CARGANDO');
        scheduleWeatherRefresh(races, season);

        const storageKey = `gridposition-weather-${season}-${nextRace.date}`;
        try {
            const query = new URLSearchParams({
                latitude: String(nextRace.latitude),
                longitude: String(nextRace.longitude),
                daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
                start_date: nextRace.date,
                end_date: nextRace.date,
                timezone: 'auto'
            });
            const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
                signal: weatherAbortController.signal
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.reason || `Open-Meteo respondió HTTP ${response.status}.`);
            }
            if (!payload.daily || !Array.isArray(payload.daily.time)) {
                throw new Error('Open-Meteo no devolvió una previsión diaria válida.');
            }
            renderWeatherForecast(nextRace, payload.daily);
            try {
                localStorage.setItem(storageKey, JSON.stringify({
                    daily: payload.daily,
                    savedAt: new Date().toISOString()
                }));
            } catch (error) {
                console.error('No se pudo guardar la previsión meteorológica local:', error);
            }
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('No se pudo cargar la previsión de Open-Meteo:', error);
            try {
                const cached = JSON.parse(localStorage.getItem(storageKey) || 'null');
                if (!cached?.daily) throw new Error('No hay una previsión guardada para esta carrera.');
                renderWeatherForecast(nextRace, cached.daily, cached.savedAt);
            } catch (storageError) {
                console.error('No se pudo recuperar el respaldo de la previsión:', storageError);
                setWeatherMessage(raceLabel, 'La previsión meteorológica no está disponible.', 'OPEN-METEO NO DISPONIBLE');
            }
        }
    }

    function renderCalendar() {
        if (!byId('upcoming-races') || !byId('completed-races')) return;
        const races = data.races.slice().sort((a, b) => a.date.localeCompare(b.date));
        renderRaceCards(races, data.season, true);
        loadCalendar();
    }

    function renderRaceCards(races, season, isFallback) {
        const upcomingContainer = byId('upcoming-races');
        const completedContainer = byId('completed-races');
        const status = byId('calendar-status');
        const progress = byId('calendar-progress');
        if (!upcomingContainer || !completedContainer || !status || !progress) return;

        const now = Date.now();
        const today = localToday();
        const raceStartTime = race => new Date(
            `${race.date}T${race.time || '00:00:00Z'}`
        ).getTime();
        const orderedRaces = races.slice().sort((a, b) =>
            a.date.localeCompare(b.date) ||
            (a.time || '').localeCompare(b.time || '') ||
            Number(a.round) - Number(b.round)
        );
        const completedRaces = orderedRaces.filter(race =>
            race.date < today || Boolean(race.winner || race.openF1?.winner)
        );
        const upcomingRaces = orderedRaces.filter(race => !completedRaces.includes(race));
        const upcomingRace = upcomingRaces.find(race => raceStartTime(race) > now);
        const upcomingFragment = document.createDocumentFragment();
        const completedFragment = document.createDocumentFragment();

        const addRaceCard = (race, isCompleted) => {
            const isRaceDay = !isCompleted && race.date === today;
            const isNext = !isFallback && !isCompleted && upcomingRace === race;
            const card = create('article', [
                'race-card',
                isCompleted ? 'is-completed' : 'is-upcoming',
                isRaceDay ? 'is-race-day' : '',
                isNext ? 'is-next-race' : ''
            ].filter(Boolean).join(' '));
            const heading = create('h2', '', race.name);
            const circuitName = race.circuitName || data.circuits.find(item => item.id === race.circuit)?.name;
            card.append(
                create('span', 'race-round', `RONDA ${race.round}`),
                heading,
                create('p', 'race-circuit', circuitName || 'Circuito no disponible'),
                create('p', '', `${race.city} · ${race.country}`),
                create('p', 'race-date', race.time
                    ? `${localDate(race.date)} · ${race.time.replace(/Z$/, ' UTC')}`
                    : localDate(race.date)),
            );

            if (isCompleted) {
                const winner = race.openF1?.winner
                    ? { ...(race.winner || {}), ...race.openF1.winner }
                    : race.winner;
                appendWinnerDetails(card, winner, 'Ganador', isFallback);
            } else {
                appendWinnerDetails(card, race.lastWinner, 'Último ganador en este circuito', isFallback);
            }

            card.append(create('span', 'race-status', isCompleted
                ? 'FINALIZADO'
                : isRaceDay ? 'GRAN PREMIO HOY · RESULTADO PENDIENTE'
                    : isNext ? 'SIGUIENTE GRAN PREMIO' : 'PRÓXIMO'));
            (isCompleted ? completedFragment : upcomingFragment).append(card);
        };

        completedRaces.forEach(race => addRaceCard(race, true));
        upcomingRaces.forEach(race => addRaceCard(race, false));

        upcomingContainer.replaceChildren(upcomingFragment);
        completedContainer.replaceChildren(completedFragment);
        byId('upcoming-empty').hidden = upcomingRaces.length > 0;
        byId('completed-empty').hidden = completedRaces.length > 0;
        calendarSeason = season;
        const completed = completedRaces.length;
        const remaining = upcomingRaces.length;
        status.textContent = isFallback
            ? `${data.dataLabel} · respaldo local ordenado cronológicamente.`
            : `Calendario ${season} de Jolpica · ${orderedRaces.length} Grandes Premios en orden cronológico.`;
        progress.textContent = `${remaining} pendientes o en curso · ${completed} realizadas.`;
        setNextRaceCountdown(upcomingRace && !isFallback ? {
            name: upcomingRace.name,
            startAt: `${upcomingRace.date}T${upcomingRace.time || '00:00:00Z'}`
        } : data.nextRace);
        updateWeatherForecast(orderedRaces, season);
    }

    function appendWinnerDetails(card, winner, label, isFallback) {
        const details = create('p', 'race-winner');
        if (!winner?.name) {
            const localDriver = winner?.number
                ? data.drivers.find(driver => Number(driver.number) === Number(winner.number))
                : null;
            if (!localDriver) {
                details.textContent = `${label}: resultado no disponible en ${isFallback ? 'el respaldo local' : 'Jolpica'}.`;
                card.append(details);
                return;
            }
            winner = { ...winner, name: localDriver.name };
            const localTeam = teamFor(localDriver.team);
            if (!winner.team && localTeam) winner.team = localTeam.shortName;
        }

        const winnerName = winner.name || (winner.number ? `Piloto #${winner.number}` : 'no disponible');
        details.append(create('strong', '', `${label}: ${winnerName}`));
        if (winner.number && winner.name) details.append(document.createTextNode(` · #${winner.number}`));
        if (winner.team) details.append(document.createTextNode(` · ${winner.team}`));
        if (winner.raceTime) {
            details.append(document.createElement('br'));
            details.append(create('span', 'winner-lap', `Tiempo de carrera: ${winner.raceTime}`));
            if (winner.laps) details.append(document.createTextNode(` · ${winner.laps} vueltas`));
        }
        if (winner.fastestLap) {
            details.append(document.createElement('br'));
            const lapLabel = winner.fastestLapNumber
                ? `Mejor vuelta del ganador (vuelta ${winner.fastestLapNumber}): ${winner.fastestLap}`
                : `Mejor vuelta del ganador: ${winner.fastestLap}`;
            details.append(create('span', 'winner-lap', lapLabel));
        } else {
            details.append(document.createElement('br'));
            details.append(create('span', 'winner-lap', 'Mejor vuelta del ganador: no disponible'));
        }
        if (winner.season) {
            details.append(document.createElement('br'));
            details.append(create('span', 'winner-season', `Edición ${winner.season}`));
        }
        card.append(details);
    }

    async function loadCalendar() {
        const status = byId('calendar-status');
        if (!status) return;
        status.textContent = `${data.dataLabel} · consultando el calendario oficial en Jolpica…`;
        try {
            const payload = await getCurrentCalendar();
            renderRaceCards(payload.races, payload.season, false);
            loadOpenF1Results(payload.season, payload.races, false);
        } catch (error) {
            console.error('No se pudo cargar el calendario de Jolpica:', error);
            status.textContent = `Jolpica no disponible (${error.message}). Se mantiene el calendario local de ${data.season}.`;
            loadOpenF1Results(data.season, data.races, true);
        }
    }

    async function loadOpenF1Results(season, races, isFallback) {
        const status = byId('openf1-status');
        if (!status) return;

        const storageKey = `gridposition-openf1-results-${season}`;
        const applyResults = results => {
            const resultsByDate = new Map(results.map(result => [result.date, result]));
            races.forEach(race => {
                const openF1Race = resultsByDate.get(race.date);
                if (openF1Race?.winner?.number) race.openF1 = openF1Race;
            });
            renderRaceCards(races, season, isFallback);
        };

        status.hidden = false;
        status.textContent = 'Cargando tiempos de carrera y vueltas desde OpenF1…';
        try {
            const response = await fetch(`/api/openf1-results?season=${encodeURIComponent(season)}&_=${Date.now()}`, {
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `El servidor respondió HTTP ${response.status}.`);
            }
            if (payload.provider !== 'OpenF1' || !Array.isArray(payload.results)) {
                throw new Error('OpenF1 devolvió un formato de resultados no válido.');
            }
            const today = localToday();
            if (payload.results.length === 0 && races.some(race =>
                race.date < today || race.winner
            )) {
                throw new Error('OpenF1 no devolvió resultados para las carreras finalizadas.');
            }
            applyResults(payload.results);
            try {
                localStorage.setItem(storageKey, JSON.stringify(payload.results));
                status.hidden = true;
            } catch (error) {
                console.error('No se pudieron guardar los resultados OpenF1 localmente:', error);
                status.textContent = 'Resultados OpenF1 cargados, pero no se pudieron guardar en este navegador.';
            }
        } catch (error) {
            console.error('No se pudieron cargar los resultados OpenF1:', error);
            try {
                const cachedResults = JSON.parse(localStorage.getItem(storageKey) || 'null');
                if (!Array.isArray(cachedResults)) throw new Error('No hay resultados OpenF1 guardados localmente.');
                applyResults(cachedResults);
                status.textContent = 'OpenF1 no está disponible. Se muestran los últimos resultados guardados en este navegador.';
            } catch (storageError) {
                console.error('No se pudo recuperar el respaldo local OpenF1:', storageError);
                status.textContent = 'OpenF1 no está disponible. Se mantienen los resultados alternativos del calendario.';
            }
        }
    }

    function renderCircuitIndex() {
        const container = byId('circuit-list');
        if (!container) return;
        renderBlogCards('circuit-list', 'circuit-list-status', circuitArticles(), 'circuitos');
    }

    function renderCircuitDetail() {
        const container = byId('circuit-detail');
        if (!container) return;
        const circuit = data.circuits.find(item => item.id === params.get('circuito'));
        if (!circuit) {
            byId('circuit-title').textContent = 'CIRCUITO';
            byId('circuit-status').textContent =
                'Elige un trazado del catálogo para ver la información local.';
            return;
        }
        byId('circuit-title').textContent = circuit.name;
        byId('circuit-location').textContent = `${circuit.city} · ${circuit.country}`;
        byId('circuit-status').textContent =
            `Archivo histórico local · primera temporada registrada: ${circuit.firstSeason}.`;
        byId('circuit-history-copy').textContent = circuit.history;
        const races = data.races.filter(race => race.circuit === circuit.id);
        const list = byId('circuit-history');
        const fragment = document.createDocumentFragment();
        races.forEach(race => {
            const item = create('li');
            item.append(
                create('span', '', race.name),
                create('time', '', `${data.season} · ${localDate(race.date)}`)
            );
            fragment.append(item);
        });
        list.replaceChildren(fragment);
    }

    function renderNewsIndex() {
        const container = byId('news-list');
        if (!container) return;
        if (data.articles.some(item => item.id === params.get('articulo'))) {
            container.hidden = true;
            return;
        }
        container.hidden = false;
        renderLocalNewsFallback();
        byId('news-status').textContent = 'Consultando noticias de Fórmula 1 en español…';
        loadLiveNews();
    }

    function renderLocalNewsFallback() {
        const container = byId('news-list');
        const fragment = document.createDocumentFragment();
        data.articles.forEach(article => {
            const card = create('article', 'article-card');
            card.append(create('span', 'article-tag', `ARCHIVO LOCAL · ${article.category}`));
            const heading = create('h2');
            const anchor = create('a', '', article.title);
            anchor.href = link('noticias.html', 'articulo', article.id);
            heading.append(anchor);
            card.append(heading, create('p', '', article.excerpt));
            card.append(create('span', 'article-date', article.date));
            const readLink = create('a', 'news-read-link', 'Leer guía completa');
            readLink.href = link('noticias.html', 'articulo', article.id);
            card.append(readLink);
            fragment.append(card);
        });
        container.replaceChildren(fragment);
    }

    async function loadLiveNews() {
        const status = byId('news-status');
        try {
            const response = await fetch(`/api/news?_=${Date.now()}`, {
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `El servidor respondió HTTP ${response.status}.`);
            }
            if (payload.provider !== 'Bing News RSS · España' || !Array.isArray(payload.articles) || !payload.articles.length) {
                throw new Error('El feed RSS devolvió un formato de noticias no válido.');
            }
            const fragment = document.createDocumentFragment();
            payload.articles.forEach(article => {
                const card = create('article', 'article-card');
                card.append(create('span', 'article-tag', article.source || 'FÓRMULA 1 · ACTUALIDAD'));
                card.append(create('h2', '', article.title));
                card.append(create('p', '', article.description));
                if (article.publishedAt) {
                    const published = new Date(article.publishedAt);
                    if (Number.isFinite(published.getTime())) {
                        card.append(create('span', 'article-date', published.toLocaleDateString('es-ES', {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric'
                        })));
                    }
                }
                const readLink = create('a', 'news-read-link', 'Leer noticia completa ↗');
                readLink.href = article.link;
                readLink.target = '_blank';
                readLink.rel = 'noopener noreferrer';
                card.append(readLink);
                fragment.append(card);
            });
            byId('news-list').replaceChildren(fragment);
            status.textContent = `${payload.articles.length} noticias de medios en español · actualizado desde ${payload.provider}.`;
        } catch (error) {
            console.error('No se pudo mostrar el feed actual de noticias:', error);
            status.textContent = `El feed de noticias no está disponible (${error.message}). Se muestran contenidos editoriales locales como respaldo; no son noticias de actualidad.`;
        }
    }

    function renderNewsArticle() {
        const container = byId('news-article');
        if (!container) return;
        const article = data.articles.find(item => item.id === params.get('articulo'));
        if (!article) {
            byId('news-status').textContent = 'Elige un artículo local desde la sección de noticias.';
            return;
        }
        container.hidden = false;
        byId('news-title').textContent = article.title;
        byId('news-category').textContent = article.category;
        byId('news-excerpt').textContent = article.excerpt;
        byId('news-body').textContent = article.body;
        byId('news-date').textContent = article.date;
        byId('news-status').textContent = 'Artículo editorial local · sin API ni actualización automática.';
    }

    function renderHistoricalChampions() {
        const container = byId('champion-list');
        if (!container) return;
        const fragment = document.createDocumentFragment();
        data.historicalChampions.forEach(champion => {
            const item = create('li');
            const anchor = create('a', 'champion-link');
            anchor.href = link('piloto.html', 'piloto', champion.id);
            anchor.append(
                create('strong', '', champion.name),
                create('span', '', `${champion.titles} títulos · ${champion.years}`)
            );
            item.append(anchor);
            fragment.append(item);
        });
        container.replaceChildren(fragment);
        const status = byId('champions-status');
        if (status) {
            status.textContent = `${data.historicalChampions.length} perfiles de campeones almacenados localmente.`;
        }
    }

    renderCountdown();
    loadGlobalCountdown();
    renderHomeRankings();
    renderTeams();
    renderTeamDetail();
    renderDriverDetail();
    renderCalendar();
    renderCircuitIndex();
    renderCircuitDetail();
    if (blog) {
        renderBlogCards('eras-list', 'eras-status', blog.eras, 'eras');
        renderBlogCards('technology-list', 'technology-status', blog.technology, 'tecnica');
    }
    renderNewsIndex();
    renderNewsArticle();
    renderHistoricalChampions();
    renderBlogArticle();
})();
