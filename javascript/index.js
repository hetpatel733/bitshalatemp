const Client = require('bitcoin-core');
const fs = require('fs');

const client = new Client({
    network: 'regtest',
    username: 'alice',
    password: 'password',
    host: '127.0.0.1',
    port: 18443
});

// Helper: create a wallet-specific RPC client
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

// Helper: create or load a wallet, handling "already exists" / "already loaded" errors
async function createOrLoadWallet(name) {
    try {
        await client.createWallet(name);
        console.log(`Wallet '${name}' created.`);
    } catch (err) {
        if (err.message && (err.message.includes('already exists') || err.message.includes('Database already exists'))) {
            // Wallet exists on disk, try to load it
            try {
                await client.loadWallet(name);
                console.log(`Wallet '${name}' loaded.`);
            } catch (loadErr) {
                if (loadErr.message && loadErr.message.includes('already loaded')) {
                    console.log(`Wallet '${name}' is already loaded.`);
                } else {
                    throw loadErr;
                }
            }
        } else {
            throw err;
        }
    }
}

async function main() {
    // ============================================================
    // Step 1: Create/Load the wallets: Miner, Employee, and Employer
    // ============================================================
    await createOrLoadWallet('Miner');
    await createOrLoadWallet('Employee');
    await createOrLoadWallet('Employer');

    const minerClient = walletClient('Miner');
    const employeeClient = walletClient('Employee');
    const employerClient = walletClient('Employer');

    // ============================================================
    // Step 2: Generate spendable balances in Miner wallet (≥ 150 BTC)
    //         then send some coins to Employer
    // ============================================================

    // Get a Miner address and mine 101 blocks to it (coinbase needs 100 confirmations to mature)
    const minerAddress = await minerClient.getNewAddress();
    await minerClient.generateToAddress(101, minerAddress);

    // Check Miner balance and confirm it's sufficient
    const minerBalance = await minerClient.getBalance();
    console.log('Miner balance after mining:', minerBalance, 'BTC');

    // Send 150 BTC from Miner to Employer
    const employerAddress = await employerClient.getNewAddress();
    await minerClient.sendToAddress(employerAddress, 150);

    // Mine one block to confirm the transfer
    await minerClient.generateToAddress(1, minerAddress);

    const employerBalance = await employerClient.getBalance();
    console.log('Employer balance after funding:', employerBalance, 'BTC');

    // ============================================================
    // Step 3: Create a salary transaction of 40 BTC from Employer to Employee
    //         with an absolute timelock of 500 blocks
    // ============================================================

    // Get an Employee address for the salary payment
    const employeeAddress = await employeeClient.getNewAddress();

    // List Employer's unspent outputs to build the raw transaction
    const employerUtxos = await employerClient.listUnspent();
    
    // Select UTXO(s) that cover 40 BTC + fee
    let inputAmount = 0;
    const selectedUtxos = [];
    for (const utxo of employerUtxos) {
        selectedUtxos.push(utxo);
        inputAmount += utxo.amount;
        if (inputAmount >= 40.001) break;
    }

    // Build inputs array with sequence set to 0xFFFFFFFE to enable locktime
    const fundingInputs = selectedUtxos.map(utxo => ({
        txid: utxo.txid,
        vout: utxo.vout,
        sequence: 0xFFFFFFFE  // Required for nLockTime to be enforced
    }));

    // Build outputs: 40 BTC to Employee, change back to Employer
    const changeAddress = await employerClient.getNewAddress();
    const fee = 0.001;
    const changeAmount = parseFloat((inputAmount - 40 - fee).toFixed(8));
    
    const fundingOutputs = {};
    fundingOutputs[employeeAddress] = 40;
    if (changeAmount > 0) {
        fundingOutputs[changeAddress] = changeAmount;
    }

    // Create the raw transaction with locktime = 500
    const fundingRawTx = await employerClient.createRawTransaction(
        fundingInputs,
        fundingOutputs,
        500  // nLockTime = 500 blocks
    );

    // Sign the raw transaction with the Employer wallet
    const signedFundingTx = await employerClient.signRawTransactionWithWallet(fundingRawTx);
    console.log('Timelocked funding tx signed:', signedFundingTx.complete);

    // ============================================================
    // Step 4: Report what happens when trying to broadcast before block 500
    // ============================================================
    // Attempting to broadcast this transaction before block 500 will fail with an error:
    // "non-final" or "Transaction is not final" because the nLockTime of 500
    // has not yet been reached. The mempool and miners will reject the transaction
    // until the blockchain height is at least 500.

    // ============================================================
    // Step 5: Mine up to the 500th block and broadcast the transaction
    // ============================================================
    const currentHeight = await client.getBlockCount();
    const blocksNeeded = 500 - currentHeight;
    console.log(`Current block height: ${currentHeight}, need to mine ${blocksNeeded} more blocks to reach 500.`);

    if (blocksNeeded > 0) {
        await minerClient.generateToAddress(blocksNeeded, minerAddress);
    }

    const heightAfterMining = await client.getBlockCount();
    console.log('Block height after mining:', heightAfterMining);

    // Now broadcast the timelocked funding transaction
    const fundingTxid = await client.sendRawTransaction(signedFundingTx.hex);
    console.log('Funding txid (timelocked):', fundingTxid);

    // Mine one more block to confirm the funding transaction
    await minerClient.generateToAddress(1, minerAddress);

    // ============================================================
    // Step 6: Print the balances of Employee and Employer after funding
    // ============================================================
    const employeeBalanceAfterFunding = await employeeClient.getBalance();
    const employerBalanceAfterFunding = await employerClient.getBalance();
    console.log('Employee balance after funding tx:', employeeBalanceAfterFunding, 'BTC');
    console.log('Employer balance after funding tx:', employerBalanceAfterFunding, 'BTC');

    // ============================================================
    // Step 7: Create a spending transaction where Employee spends the 40 BTC
    //         to a new Employee address, with an OP_RETURN output
    // ============================================================

    // Get the specific UTXO from the funding transaction (40 BTC output)
    const fundingTxDetails = await client.getRawTransaction(fundingTxid, true);
    const salaryVout = fundingTxDetails.vout.find(o => o.value === 40);
    const salaryVoutIndex = salaryVout.n;

    // New Employee address to receive the spent funds
    const newEmployeeAddress = await employeeClient.getNewAddress();

    // OP_RETURN data: "I got my salary, I am rich" encoded as hex
    const opReturnData = Buffer.from('I got my salary, I am rich').toString('hex');

    // Build the spending transaction inputs
    const spendingInputs = [{
        txid: fundingTxid,
        vout: salaryVoutIndex,
        sequence: 0xFFFFFFFE
    }];

    // Build the spending transaction outputs:
    //   - Send funds (minus fee) to new Employee address
    //   - Add OP_RETURN data output
    const spendingFee = 0.001;
    const spendAmount = parseFloat((40 - spendingFee).toFixed(8));

    const spendingOutputs = [
        { [newEmployeeAddress]: spendAmount },
        { data: opReturnData }
    ];

    // Create the raw spending transaction
    const spendingRawTx = await employeeClient.createRawTransaction(spendingInputs, spendingOutputs);

    // ============================================================
    // Step 8: Sign and broadcast the spending transaction
    // ============================================================
    const signedSpendingTx = await employeeClient.signRawTransactionWithWallet(spendingRawTx);
    console.log('Spending tx signed:', signedSpendingTx.complete);

    const spendingTxid = await client.sendRawTransaction(signedSpendingTx.hex);
    console.log('Spending txid:', spendingTxid);

    // Mine a block to confirm the spending transaction
    await minerClient.generateToAddress(1, minerAddress);

    // ============================================================
    // Step 9: Print the final balances of Employee and Employer
    // ============================================================
    const finalEmployeeBalance = await employeeClient.getBalance();
    const finalEmployerBalance = await employerClient.getBalance();
    console.log('Final Employee balance:', finalEmployeeBalance, 'BTC');
    console.log('Final Employer balance:', finalEmployerBalance, 'BTC');

    // ============================================================
    // Step 10: Output the txids to out.txt
    //   Line 1: txid of the timelocked funding transaction
    //   Line 2: txid of the spending transaction
    // ============================================================
    const outContent = `${fundingTxid}\n${spendingTxid}\n`;
    fs.writeFileSync('out.txt', outContent);
    console.log('Transaction IDs written to out.txt');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});