class Account {
    name!: string;
    balance!: number;

    logDeposit(amount: number) {
        this.logAmount(amount);
    }

    logWithdrawal(amount: number) {
        this.logAmount(amount);
    }

    logAmount(amount: number) {
        const record = `${this.name}: ${amount}`;
        console.log(record);
    }
}
