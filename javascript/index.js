const Client = require('bitcoin-core');
const fs = require('fs');

const baseConfig = {
    network: 'regtest',
    username: 'alice',
    password: 'password',
    host: '127.0.0.1',
    port: 18443
};

const client = new Client(baseConfig);

function getWalletClient(walletName) {
    return new Client({ ...baseConfig, wallet: walletName });
}

async function loadOrCreateWallet(name) {
    try {
        await client.command('loadwallet', name);
        console.log(`Wallet '${name}' loaded`);
    } catch (e) {
        const msg = (e.message || '').toLowerCase();
        if (msg.includes('already loaded')) {
            console.log(`Wallet '${name}' already loaded`);
        } else {
            // Try creating as legacy wallet first (descriptors=false for simpler multisig handling)
            try {
                await client.command('createwallet', name, false, false, '', false, false);
                console.log(`Wallet '${name}' created (legacy)`);
            } catch (createErr) {
                const cMsg = (createErr.message || '').toLowerCase();
                if (cMsg.includes('already exists') || cMsg.includes('database already exists')) {
                    await client.command('loadwallet', name);
                    console.log(`Wallet '${name}' loaded (existing)`);
                } else {
                    // Fall back to descriptor wallet
                    try {
                        await client.command('createwallet', name);
                        console.log(`Wallet '${name}' created (descriptor)`);
                    } catch (e2) {
                        const e2Msg = (e2.message || '').toLowerCase();
                        if (e2Msg.includes('already exists') || e2Msg.includes('database already exists')) {
                            await client.command('loadwallet', name);
                            console.log(`Wallet '${name}' loaded (existing)`);
                        } else {
                            throw e2;
                        }
                    }
                }
            }
        }
    }
}

async function main() {
    // Get blockchain info
    const blockchainInfo = await client.getBlockchainInfo();
    console.log('Blockchain Info:', blockchainInfo);

    // Create/Load the wallets, named 'Miner', 'Alice' and 'Bob'
    await loadOrCreateWallet('Miner');
    await loadOrCreateWallet('Alice');
    await loadOrCreateWallet('Bob');

    const miner = getWalletClient('Miner');
    const alice = getWalletClient('Alice');
    const bob = getWalletClient('Bob');

    // Generate spendable balances in the Miner wallet (≥ 150 BTC)
    // Regtest coinbase maturity = 100 blocks, so mine at least 103 blocks for 3 * 50 BTC = 150 BTC
    const minerAddress = await miner.getNewAddress();
    const currentBlocks = (await client.getBlockchainInfo()).blocks;

    if (currentBlocks < 103) {
        const blocksToMine = 103 - currentBlocks;
        console.log(`Mining ${blocksToMine} blocks to Miner address...`);
        await client.command('generatetoaddress', blocksToMine, minerAddress);
    }

    let minerBalance = await miner.getBalance();
    while (minerBalance < 150) {
        console.log(`Miner balance ${minerBalance} BTC, mining more blocks...`);
        await client.command('generatetoaddress', 3, minerAddress);
        minerBalance = await miner.getBalance();
    }
    console.log(`Miner balance: ${minerBalance} BTC`);

    // Send 15 BTC each to Alice and Bob
    const aliceFundAddress = await alice.getNewAddress();
    const bobFundAddress = await bob.getNewAddress();
    await miner.sendToAddress(aliceFundAddress, 15);
    await miner.sendToAddress(bobFundAddress, 15);

    // Mine 6 blocks to confirm the funding transactions
    await client.command('generatetoaddress', 6, minerAddress);
    console.log(`Alice balance after funding: ${await alice.getBalance()} BTC`);
    console.log(`Bob balance after funding: ${await bob.getBalance()} BTC`);

    // Construct 2-of-2 multisig (Alice & Bob) using P2WSH (native segwit)
    // Get a legacy address from each wallet to extract their compressed public keys
    const aliceKeyAddr = await alice.getNewAddress('', 'legacy');
    const bobKeyAddr = await bob.getNewAddress('', 'legacy');
    const aliceAddrInfo = await alice.getAddressInfo(aliceKeyAddr);
    const bobAddrInfo = await bob.getAddressInfo(bobKeyAddr);
    const alicePubKey = aliceAddrInfo.pubkey;
    const bobPubKey = bobAddrInfo.pubkey;
    console.log(`Alice pubkey: ${alicePubKey}`);
    console.log(`Bob pubkey: ${bobPubKey}`);

    // Create 2-of-2 P2WSH multisig address (bech32 = native segwit witness_v0_scripthash)
    const multisigResult = await client.command('createmultisig', 2, [alicePubKey, bobPubKey], 'bech32');
    const multisigAddress = multisigResult.address;
    const witnessScript = multisigResult.redeemScript;
    console.log(`Multisig P2WSH address: ${multisigAddress}`);
    console.log(`Witness script: ${witnessScript}`);

    // Register the multisig in both wallets so they can sign spending transactions
    try {
        await alice.command('addmultisigaddress', 2, [alicePubKey, bobPubKey], '', 'bech32');
        await bob.command('addmultisigaddress', 2, [alicePubKey, bobPubKey], '', 'bech32');
        console.log('Multisig registered in Alice and Bob wallets');
    } catch (e) {
        // Descriptor wallet fallback: use importdescriptors
        console.log(`addmultisigaddress failed (${e.message}), falling back to importdescriptors`);
        const desc = `wsh(multi(2,${alicePubKey},${bobPubKey}))`;
        const descInfo = await client.command('getdescriptorinfo', desc);
        const fullDesc = descInfo.descriptor;
        await alice.command('importdescriptors', [{ desc: fullDesc, timestamp: 'now' }]);
        await bob.command('importdescriptors', [{ desc: fullDesc, timestamp: 'now' }]);
        console.log('Multisig descriptor imported into Alice and Bob wallets');
    }

    // Build funding PSBT: Alice and Bob each contribute one UTXO (15 BTC each)
    // Total input: 30 BTC → 20 BTC to multisig + equal change to Alice and Bob
    const aliceUTXOs = await alice.command('listunspent');
    const bobUTXOs = await bob.command('listunspent');

    const aliceUTXO = aliceUTXOs.find(u => u.amount >= 10);
    const bobUTXO = bobUTXOs.find(u => u.amount >= 10);
    if (!aliceUTXO || !bobUTXO) throw new Error('Insufficient UTXOs for Alice or Bob');

    const totalInput = aliceUTXO.amount + bobUTXO.amount;
    const multisigAmount = 20;
    const fundingFee = 0.0002;
    // Both change outputs must be exactly equal (validated by test)
    const changeEach = parseFloat(((totalInput - multisigAmount - fundingFee) / 2).toFixed(8));

    const aliceChangeAddress = await alice.getNewAddress();
    const bobChangeAddress = await bob.getNewAddress();

    const fundingInputs = [
        { txid: aliceUTXO.txid, vout: aliceUTXO.vout },
        { txid: bobUTXO.txid, vout: bobUTXO.vout }
    ];
    const fundingOutputs = [
        { [multisigAddress]: multisigAmount },
        { [aliceChangeAddress]: changeEach },
        { [bobChangeAddress]: changeEach }
    ];

    // Create raw PSBT and populate UTXO data
    let fundingPsbt = await client.command('createpsbt', fundingInputs, fundingOutputs);
    fundingPsbt = await client.command('utxoupdatepsbt', fundingPsbt);

    // Each wallet signs its own input
    const aliceFundSigned = await alice.command('walletprocesspsbt', fundingPsbt);
    const bobFundSigned = await bob.command('walletprocesspsbt', fundingPsbt);

    // Combine partial signatures and finalize
    const combinedFunding = await client.command('combinepsbt', [aliceFundSigned.psbt, bobFundSigned.psbt]);
    const finalizedFunding = await client.command('finalizepsbt', combinedFunding);
    if (!finalizedFunding.complete) throw new Error('Funding PSBT could not be finalized');

    // Sign & broadcast the funding PSBT
    const fundingTxId = await client.sendRawTransaction(finalizedFunding.hex);
    console.log(`Funding TX ID: ${fundingTxId}`);

    // Mine 6 blocks to confirm
    await client.command('generatetoaddress', 6, minerAddress);
    console.log('Mined 6 blocks to confirm funding transaction');

    // Print balances for Alice and Bob
    console.log(`Alice balance: ${await alice.getBalance()} BTC`);
    console.log(`Bob balance: ${await bob.getBalance()} BTC`);

    // Build spending PSBT: spend the multisig output, distributing ~10 BTC equally to Alice and Bob
    const fundingTxDetails = await client.command('getrawtransaction', fundingTxId, true);
    let multisigVout = -1;
    for (let i = 0; i < fundingTxDetails.vout.length; i++) {
        const out = fundingTxDetails.vout[i];
        if (Math.abs(out.value - multisigAmount) < 0.00001 &&
            out.scriptPubKey.type === 'witness_v0_scripthash') {
            multisigVout = i;
            break;
        }
    }
    if (multisigVout === -1) throw new Error('Multisig UTXO not found in funding transaction');

    const aliceReceiveAddress = await alice.getNewAddress();
    const bobReceiveAddress = await bob.getNewAddress();
    const spendingFee = 0.0002;
    const eachReceives = parseFloat(((multisigAmount - spendingFee) / 2).toFixed(8));

    const spendingInputs = [{ txid: fundingTxId, vout: multisigVout }];
    const spendingOutputs = [
        { [aliceReceiveAddress]: eachReceives },
        { [bobReceiveAddress]: eachReceives }
    ];

    // Create spending PSBT and populate witness UTXO data + witness script
    let spendingPsbt = await client.command('createpsbt', spendingInputs, spendingOutputs);
    // Pass the multisig descriptor to utxoupdatepsbt so it populates the witness script
    // in the PSBT input. Without this, descriptor wallets won't recognize the multisig.
    const multisigDesc = `wsh(multi(2,${alicePubKey},${bobPubKey}))`;
    const multisigDescInfo = await client.command('getdescriptorinfo', multisigDesc);
    spendingPsbt = await client.command('utxoupdatepsbt', spendingPsbt, [multisigDescInfo.descriptor]);

    // Both Alice and Bob must sign (2-of-2 multisig)
    const aliceSpendSigned = await alice.command('walletprocesspsbt', spendingPsbt);
    const bobSpendSigned = await bob.command('walletprocesspsbt', spendingPsbt);

    // Combine partial signatures and finalize
    const combinedSpending = await client.command('combinepsbt', [aliceSpendSigned.psbt, bobSpendSigned.psbt]);
    const finalizedSpending = await client.command('finalizepsbt', combinedSpending);
    if (!finalizedSpending.complete) throw new Error('Spending PSBT could not be finalized');

    // Sign & broadcast the spending PSBT
    const spendingTxId = await client.sendRawTransaction(finalizedSpending.hex);
    console.log(`Spending TX ID: ${spendingTxId}`);

    // Mine 6 blocks to confirm the spending transaction
    await client.command('generatetoaddress', 6, minerAddress);
    console.log('Mined 6 blocks to confirm spending transaction');

    // Print final balances for Alice and Bob
    console.log(`Final Alice balance: ${await alice.getBalance()} BTC`);
    console.log(`Final Bob balance: ${await bob.getBalance()} BTC`);

    // Write transaction IDs to out.txt for test validation
    fs.writeFileSync('out.txt', `${fundingTxId}\n${spendingTxId}\n`);
    console.log('Results written to out.txt');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});