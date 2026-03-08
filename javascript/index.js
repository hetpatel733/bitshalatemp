const Client = require('bitcoin-core');
const fs = require('fs');
const path = require('path');

const client = new Client({
    network: 'regtest',
    username: 'alice',
    password: 'password',
    host: '127.0.0.1',
    port: 18443
});

function walletClient(walletName) {
    return new Client({
        network: 'regtest',
        username: 'alice',
        password: 'password',
        host: '127.0.0.1',
        port: 18443,
        wallet: walletName
    });
}

// Create or load a wallet, handling already-exists / already-loaded errors
async function createOrLoadWallet(name) {
    try {
        await client.createWallet(name);
    } catch (err) {
        if (err.message && (err.message.includes('already exists') || err.message.includes('Database already exists'))) {
            try {
                await client.loadWallet(name);
            } catch (loadErr) {
                if (!loadErr.message.includes('already loaded')) throw loadErr;
            }
        } else {
            throw err;
        }
    }
}

async function main() {
    // Create/load wallets
    await createOrLoadWallet('Miner');
    await createOrLoadWallet('Employee');
    await createOrLoadWallet('Employer');

    const minerClient = walletClient('Miner');
    const employeeClient = walletClient('Employee');
    const employerClient = walletClient('Employer');

    // Mine 200 blocks to Miner so enough coinbase rewards mature
    const minerAddress = await minerClient.getNewAddress();
    await minerClient.generateToAddress(200, minerAddress);

    // Fund Employer with 150 BTC from Miner
    const employerAddress = await employerClient.getNewAddress();
    await minerClient.sendToAddress(employerAddress, 150);
    await minerClient.generateToAddress(1, minerAddress);

    // Build timelocked funding tx: 40 BTC from Employer to Employee, locktime = 500
    const employeeAddress = await employeeClient.getNewAddress();
    const employerUtxos = await employerClient.listUnspent();

    let inputAmount = 0;
    const selectedUtxos = [];
    for (const utxo of employerUtxos) {
        selectedUtxos.push(utxo);
        inputAmount += utxo.amount;
        if (inputAmount >= 40.001) break;
    }

    // sequence 0xFFFFFFFE enables nLockTime while allowing RBF
    const fundingInputs = selectedUtxos.map(utxo => ({
        txid: utxo.txid,
        vout: utxo.vout,
        sequence: 0xFFFFFFFE
    }));

    const changeAddress = await employerClient.getNewAddress();
    const fee = 0.001;
    const changeAmount = parseFloat((inputAmount - 40 - fee).toFixed(8));

    const fundingOutputs = { [employeeAddress]: 40 };
    if (changeAmount > 0) fundingOutputs[changeAddress] = changeAmount;

    const fundingRawTx = await employerClient.createRawTransaction(fundingInputs, fundingOutputs, 500);
    const signedFundingTx = await employerClient.signRawTransactionWithWallet(fundingRawTx);

    // Broadcasting before block 500 would fail like this -- "non-final" — nLockTime not reached.
    // Mine remaining blocks to reach height 500, then broadcast.
    const currentHeight = await client.getBlockCount();
    const blocksNeeded = 500 - currentHeight;
    if (blocksNeeded > 0) {
        await minerClient.generateToAddress(blocksNeeded, minerAddress);
    }

    const fundingTxid = await client.sendRawTransaction(signedFundingTx.hex);
    await minerClient.generateToAddress(1, minerAddress);

    console.log('Employee balance:', await employeeClient.getBalance(), 'BTC');
    console.log('Employer balance:', await employerClient.getBalance(), 'BTC');

    // Locate the 40 BTC output in the funding tx for spending
    const fundingTxDetails = await client.getRawTransaction(fundingTxid, true);
    const salaryVout = fundingTxDetails.vout.find(o => o.value === 40);

    const newEmployeeAddress = await employeeClient.getNewAddress();

    // OP_RETURN Done
    const opReturnData = Buffer.from('I got my salary, I am rich').toString('hex');

    const spendingInputs = [{ txid: fundingTxid, vout: salaryVout.n, sequence: 0xFFFFFFFE }];
    const spendingOutputs = [
        { [newEmployeeAddress]: parseFloat((40 - 0.001).toFixed(8)) },
        { data: opReturnData }
    ];

    const spendingRawTx = await employeeClient.createRawTransaction(spendingInputs, spendingOutputs);
    const signedSpendingTx = await employeeClient.signRawTransactionWithWallet(spendingRawTx);
    const spendingTxid = await client.sendRawTransaction(signedSpendingTx.hex);
    await minerClient.generateToAddress(1, minerAddress);

    console.log('Final Employee balance:', await employeeClient.getBalance(), 'BTC');
    console.log('Final Employer balance:', await employerClient.getBalance(), 'BTC');

    // Write txids to out.txt
    const outPath = path.join(__dirname, '..', 'out.txt');
    fs.writeFileSync(outPath, `${fundingTxid}\n${spendingTxid}\n`);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});