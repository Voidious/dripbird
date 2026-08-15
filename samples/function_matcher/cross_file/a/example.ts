import { sendGreeting } from "./util";

function contactHome(base) {
    const signal = getSignal(base);
    signal.send("Hello,");
    signal.send("I am from Earth.");
    signal.send("We come in peace.");
}
