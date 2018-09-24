// SWIFT MT940 bank statement format JS parser
// Taken from: https://github.com/a-fas/mt940js
// Modified to run in browser (removed node.js 'require')

/**
 * MT940 parser class
 * @module lib/parser
 */

//const Tags         = require('./tags');
//const helperModels = require('./helperModels');

/**
 * Main parser class, parses input text (e.g. read from a file) into array of statements.
 * Each statement is validated for: all strictly required tags,
 * opening/closing balance currency is the same, opening balance + turnover = closing balance.
 * One input may return one or more statements (as array). Each statement contains transactions
 * array, where each contains data of tag 61 (and tag 86 for details).
 * <p>Output statement contains:</p>
 * @property {string} transactionReference - tag 20 reference
 * @property {string} relatedReference - tag 21 reference, optional
 * @property {string} accountIdentification - tag 25 own bank account identification
 * @property {string} number.statement - tag 28 main statement number
 * @property {string} number.sequence - tag 28 statement sub number (sequence)
 * @property {string} number.section - tag 28 statement sub sub number (present on some banks)
 * @property {Date} openingBalanceDate - tag 60 statement opening date
 * @property {Date} closingBalanceDate - tag 62 statement closing date
 * @property {Date} statementDate - abstraction for statement date = `closingBalanceDate`
 * @property {string} currency - statement currency
 * @property {Number} openingBalance - beginning balance of the statement
 * @property {Number} closingBalance - ending balance of the statement
 * @property {array} transactions - collection of transactions
 * @property {Date} transaction.date - transaction date
 * @property {Number} transaction.amount - transaction amount (with sign, Credit+, Debit-)
 * @property {string} transaction.currency - transaction currency (copy of statement currency)
 * @property {string} transaction.details - content of relevant 86 tag(s), may be multiline (`\n` separated)
 * @property {string} transaction.transactionType - MT940 transaction type code (e.g. NTRF ...)
 * @property {string} transaction.reference - payment reference field
 * @property {Date} transaction.entryDate - optional, entry date field
 * @property {string} transaction.fundsCode - optional, funds code field
 * @property {string} transaction.bankReference - optional, bank reference
 * @property {string} transaction.extraDetails - optional, extra details
 * @example
 * const mt940parser = new Parser();
 * const statements  = parser.parse(fs.readFileSync(path, 'utf8'));
 * for (let i of statements) {
 *   console.log(i.number.statement, i.statementDate);
 *   for (let t of i.transactions) {
 *     console.log(t.amount, t.currency);
 *   }
 * }
 */
class Parser {
  constructor() {
  }

  /**
  * Parse text data into array of statements
  * @param {string} data - text unparsed bank statement in MT940 format
  * @param {boolean} withTags - tags will be copied to output statements in `tags` attribute for further analysis
  * @return {array} Array of statements @see class documentation for details
  */
  parse(data, withTags = false) {
    const factory    = new TagFactory();
    const dataLines  = this._splitAndNormalize(data);
    const tagLines   = [...this._parseLines(dataLines)];
    const tags       = tagLines.map(i => factory.createTag(i.id, i.subId, i.data.join('\n')));
    const statements = this._groupTags(tags).map((grp, idx) => {
      this._validateGroup(grp, idx+1);
      return this._buildStatement(grp, withTags);
    });

    return statements;
  }

  /**
  * Split text into lines, replace clutter, remove empty lines ...
  * @private
  */
  _splitAndNormalize(data) {
    return data
      .split('\n')
      .map(line => {
        return line
          .replace('\r', '')
          .replace(/\s+$/, '');
      })
      .filter(line => !!line && line !== '-');
  }

  /**
  * Convert lines into separate tags
  * @private
  */
  *_parseLines(lines) {
    const reTag = /^:([0-9]{2}|NS)([A-Z])?:/;
    let tag = {};

    for (let i of lines) {

      if (i.startsWith('-}') || i.startsWith('{')) {
        continue; // Skip message headers
      }

      let match = i.match(reTag);
      if (match) { // Tag found
        if (tag.id) { yield tag } // Yield previous
        tag = { // Start new tag
          id   : match[1],
          subId: match[2] || '',
          data : [i.substr(match[0].length)]
        };
      } else { // Add a line to previous tag
        tag.data.push(i);
      }
    }

    if (tag.id) { yield tag } // Yield last
  }

  /**
  * Group tags into statements
  * @private
  */
  _groupTags(tags) {
    return tags.reduce((prev, i) => {
      if (i instanceof TagTransactionReferenceNumber) {
        prev.push([]); // Statement starting tag -> start new group
      }
      prev[prev.length-1].push(i);
      return prev;
    }, []);
  }

  /**
  * Validate group of tags (required tags present, currency is consistent, consistent balances vs turnover)
  * @private
  */
  _validateGroup(group, idx) {
    // Check mandatory tags
    [ TagTransactionReferenceNumber, //20
      TagAccountIdentification,      //25
      TagStatementNumber,            //28
      TagOpeningBalance,             //60
      TagClosingBalance              //62
    ].forEach(Tag => {
      if (!group.find(i => i instanceof Tag)) {
        throw Error(`Mandatory tag ${Tag.ID} is missing in group ${idx}`);
      }
    });

    // Check same currency
    let currency = '';
    group
    .filter(i => i instanceof TagBalance)
    .forEach(i => {
      if (!currency) {
        currency = i.fields.currency;
      } else if (currency !== i.fields.currency) {
        throw Error(`Currency markers are differ [${currency}, ${i.fields.currency}] in group ${idx}`);
      }
    });

    // Check turnover
    const ob = group.find(i => i instanceof TagOpeningBalance);
    const cb = group.find(i => i instanceof TagClosingBalance);
    const turnover = cb.fields.amount - ob.fields.amount;

    const sumLines = group
    .filter(i => i instanceof TagStatementLine)
    .reduce((prev, cur) => { return prev + cur.fields.amount }, 0.0);

    if (!BankAmount.isEqual(sumLines, turnover)) {
      throw Error(`Sum of lines (${sumLines}) != turnover (${turnover}) in group ${idx}`);
    }
  }

  /**
  * Build statement objects
  * @private
  */
  _buildStatement(group, withTags) {
    let statement = {
      transactionReference: '',
      relatedReference: '',
      accountIdentification: '',
      number: {
        statement: '',
        sequence: '',
        section: ''
      },
      statementDate: null,
      openingBalanceDate: null,
      closingBalanceDate: null,
      currency: '',
      openingBalance: 0.0,
      closingBalance: 0.0,
      transactions: []
    };

    for (let tag of group) {
      if (tag instanceof TagTransactionReferenceNumber) {
        statement.transactionReference = tag.fields.transactionReference;
      }
      if (tag instanceof TagRelatedReference) {
        statement.relatedReference = tag.fields.relatedReference;
      }
      if (tag instanceof TagAccountIdentification) {
        statement.accountIdentification = tag.fields.accountIdentification;
      }
      if (tag instanceof TagStatementNumber) {
        statement.number.statement = tag.fields.statementNumber;
        statement.number.sequence  = tag.fields.sequenceNumber;
        statement.number.section   = tag.fields.sectionNumber;
      }
      if (tag instanceof TagOpeningBalance) {
        statement.openingBalanceDate = tag.fields.date;
        statement.openingBalance     = tag.fields.amount;
        statement.currency           = tag.fields.currency;
      }
      if (tag instanceof TagClosingBalance) {
        statement.closingBalanceDate = tag.fields.date;
        statement.statementDate      = tag.fields.date;
        statement.closingBalance     = tag.fields.amount;
      }
      if (tag instanceof TagStatementLine) {
        statement.transactions.push(Object.assign({},
          tag.fields,
          {
            currency: statement.currency,
            details: ''
          }
        ));
      }
      if (tag instanceof TagTransactionDetails) {
        let t = statement.transactions[statement.transactions.length - 1];
        t.details  += (t.details && '\n') + tag.fields.transactionDetails;
      }
    }

    for (let t of statement.transactions) {
      let structuredDetails = this._detectDetailStructure(t);
      if (structuredDetails) t.structuredDetails = structuredDetails;
    }
    if (withTags) { statement.tags = group } // preserve tags

    return statement;
  }

  /**
  * Detects if field 86 is structured and attempts to parse it
  * @private
  */
  _detectDetailStructure(transaction) {
    const details   = transaction.details.replace(/\n/g, '');
    const separator = details.charAt();
    if (!'>?'.includes(separator)) return; // check first symbol is known separator
    
    const splitRe = new RegExp('\\'+ separator + '(?=\\d{2})');
    const matches = details.split(splitRe);
    if (matches.length === 1 || matches[0].length > 0) return; // line must start from a proper tag
    matches.shift(); // remove empty match at start

    return matches.reduce((struc, m) => Object.assign(struc, {
      [m.substr(0,2)]: m.substr(2)
    }), {});
  }
}

//module.exports = Parser;
