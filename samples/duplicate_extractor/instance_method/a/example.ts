class Account {
    name!: string;
    balance!: number;

    logDeposit(amount: number) {
        const record = `${this.name}: ${amount}`;
        console.log(record);
    }

    logWithdrawal(amount: number) {
        const record = `${this.name}: ${amount}`;
        console.log(record);
    }
}
