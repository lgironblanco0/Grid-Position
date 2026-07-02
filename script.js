document.addEventListener('DOMContentLoaded', () => {
    initRaceCountdown();
});

function initRaceCountdown() {
    // Establecemos una fecha objetivo ficticia pero lógica para el próximo GP de 2026
    const nextRaceDate = new Date();
    nextRaceDate.setDate(nextRaceDate.getDate() + 3); // Añade 3 días exactos desde hoy
    nextRaceDate.setHours(15, 0, 0, 0);               // Hora de salida habitual (15:00)

    const timerElement = document.getElementById('countdown-timer');

    if (timerElement) {
        const updateTimer = () => {
            const now = new Date().getTime();
            const distance = nextRaceDate.getTime() - now;

            // Cálculos lógicos de tiempo
            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);

            // Formatear números con un cero inicial si son menores de 10
            const format = num => String(num).padStart(2, '0');

            if (distance < 0) {
                timerElement.textContent = "¡SE ENCIENDEN LOS SEMÁFOROS! 🔴🔴🔴🔴🔴";
                clearInterval(interval);
            } else {
                timerElement.textContent = `${format(days)}d ${format(hours)}h ${format(minutes)}m ${format(seconds)}s`;
            }
        };

        // Ejecutar inmediatamente y programar actualización cada segundo
        updateTimer();
        const interval = setInterval(updateTimer, 1000);
    }

    
}

