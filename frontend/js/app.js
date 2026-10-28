
const directionElement = document.getElementById("head-direction");
const yawElement = document.getElementById("head-yaw");
const pitchElement = document.getElementById("head-pitch");
const rollElement = document.getElementById("head-roll");

const driverStatusElement = document.getElementById("driver-status");
const warningStatusElement = document.getElementById("warning-status");

function connectWebSocket() {
    const protocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";

    const wsUrl =
        `${protocol}//${window.location.host}/ws/head-pose`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("WebSocket connected");
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (directionElement) {
            directionElement.textContent = data.head_pose;
        }

        if (yawElement) {
            yawElement.textContent = `${data.yaw}°`;
        }

        if (pitchElement) {
            pitchElement.textContent = `${data.pitch}°`;
        }

        if (rollElement) {
            rollElement.textContent = `${data.roll}°`;
        }

        if (driverStatusElement) {
            driverStatusElement.textContent =
                data.driver_state ?? "NORMAL";

            driverStatusElement.className =
                data.driver_state === "WARNING"
                    ? "status warning"
                    : "status normal";
        }

        if (warningStatusElement) {
            warningStatusElement.textContent =
                data.warning_message ?? "NONE";

            warningStatusElement.className =
                data.warning
                    ? "status warning"
                    : "status normal";
        }
    };

    socket.onclose = () => {
        console.log("WebSocket disconnected. Reconnecting in 2 seconds...");
        setTimeout(connectWebSocket, 2000);
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        socket.close();
    };
}

connectWebSocket();
