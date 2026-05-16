function logOrder(orderId: string, total: number) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] Order ${orderId}: $${total.toFixed(2)}`;
    console.log(entry);
}

function logPayment(paymentId: string, amount: number) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] Payment ${paymentId}: $${amount.toFixed(2)}`;
    console.log(entry);
}
