const Client = require('bitcoin-core');
const fs = require('fs');

const client = new Client({
  network: 'regtest',
  username: 'alice',
  password: 'password',
  port: 18443,
  host: '127.0.0.1'
});

async function main() {
  try {
    console.log('🚀 Bitcoin Regtest Testing\n');

    // Create wallets
    console.log('📝 Creating wallets...');
    try {
      await client.createWallet('Miner');
      console.log('✓ Miner wallet created');
    } catch (e) {
      try {
        await client.loadWallet('Miner');
        console.log('✓ Miner wallet loaded');
      } catch (le) {
        console.log('⚠️  Miner wallet already loaded');
      }
    }

    try {
      await client.createWallet('Trader');
      console.log('✓ Trader wallet created\n');
    } catch (e) {
      try {
        await client.loadWallet('Trader');
        console.log('✓ Trader wallet loaded\n');
      } catch (le) {
        console.log('⚠️  Trader wallet already loaded\n');
      }
    }

    // Get Miner address
    console.log('⛏️  Getting Miner address...');
    const minerClient = new Client({
      network: 'regtest',
      username: 'alice',
      password: 'password',
      port: 18443,
      host: '127.0.0.1',
      wallet: 'Miner'
    });

    const minerAddr = await minerClient.getNewAddress();
    console.log(`✓ Miner address: ${minerAddr}\n`);

    // Mine 101 blocks
    console.log('⛏️  Mining 101 blocks...');
    const blocks = await client.generateToAddress(101, minerAddr);
    console.log(`✓ Mined ${blocks.length} blocks\n`);

    // Get Miner balance
    console.log('💰 Checking Miner balance...');
    const minerBalance = await minerClient.getBalance();
    console.log(`✓ Miner balance: ${minerBalance} BTC\n`);

    // Get Trader address
    console.log('📤 Getting Trader address...');
    const traderClient = new Client({
      network: 'regtest',
      username: 'alice',
      password: 'password',
      port: 18443,
      host: '127.0.0.1',
      wallet: 'Trader'
    });

    const traderAddr = await traderClient.getNewAddress();
    console.log(`✓ Trader address: ${traderAddr}\n`);

    // Send 20 BTC
    console.log('📤 Sending 20 BTC from Miner to Trader...');
    const txid = await minerClient.sendToAddress(traderAddr, 20);
    console.log(`✓ Transaction ID: ${txid}\n`);

    // Mine confirmation block
    console.log('⛏️  Mining confirmation block...');
    const confirmBlock = await client.generateToAddress(1, minerAddr);
    console.log(`✓ Block hash: ${confirmBlock[0]}\n`);

    // Get transaction details
    console.log('📋 Transaction Details:');
    const txData = await client.getRawTransaction(txid, true);
    console.log(`Transaction ID: ${txid}`);
    console.log(`Confirmations: ${txData.confirmations}`);
    console.log(`Block hash: ${txData.blockhash}`);

    // Get outputs
    const outputs = txData.vout;
    let traderAmount = 0;
    let changeAmount = 0;

    for (const output of outputs) {
      const address = output.scriptPubKey.address;
      if (address === traderAddr) {
        traderAmount = output.value;
      } else {
        changeAmount = output.value;
      }
    }

    console.log(`\n📊 Output Summary:`);
    console.log(`  Trader received: ${traderAmount} BTC`);
    console.log(`  Change: ${changeAmount} BTC`);
    console.log(`  Fee: ${(50 - traderAmount - changeAmount).toFixed(8)} BTC\n`);

    // Final balances
    console.log('💰 Final Balances:');
    const finalMinerBalance = await minerClient.getBalance();
    const finalTraderBalance = await traderClient.getBalance();
    console.log(`  Miner: ${finalMinerBalance} BTC`);
    console.log(`  Trader: ${finalTraderBalance} BTC\n`);

    // Save output
    const output = {
      timestamp: new Date().toISOString(),
      transaction: {
        txid: txid,
        from: minerAddr,
        to: traderAddr,
        amount: traderAmount,
        fee: (50 - traderAmount - changeAmount).toFixed(8)
      },
      balances: {
        miner: finalMinerBalance,
        trader: finalTraderBalance
      }
    };

    fs.writeFileSync('output.json', JSON.stringify(output, null, 2));
    console.log('✅ Results saved to output.json');
    console.log('✅ All tests completed!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();