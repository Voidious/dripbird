import { sendGreeting } from "./util";

function contactHome(base) {
    const signal = getSignal(base);
    sendGreeting(signal);
}
