require("dotenv").config();

const fs = require("fs");
const path = require("path");
const _ = require("lodash");
const moment = require("moment");
const axios = require("axios");
const SFTPClient = require("ssh2-sftp-client");
const HttpsProxyAgent = require("https-proxy-agent");
const qs = require("qs");
const xlsx = require("xlsx");
const { asyncPool, getErrorMessage } = require("./utils");

const issuer = "https://lxapi.lexiangla.com/cgi-bin";
const apiIssuer = `${issuer}/v1`;

const isLocal = () => process.env.ENV === "local";

function setHttpsProxyAgent() {
  if (process.env.HTTPS_PROXY) {
    const httpsAgent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    axios.defaults.httpsAgent = httpsAgent;
  }
}

async function fetchAllData(url, queries, included = false) {
  const results = [];
  const relationships = [];
  const pageSize = 100;
  const mergedQueries = qs.stringify(_.assign({ per_page: pageSize }, queries));
  const response = await axios.default.get(`${url}?${mergedQueries}`);
  const total = response.data.meta.total;
  if (total <= pageSize) {
    results.push(...response.data.data);
    relationships.push(...(response.data.included ?? []));
  } else {
    const times = _.times(Math.ceil(total / pageSize));
    await asyncPool(
      times,
      async function (pageNumber) {
        const mergedQueries = qs.stringify(
          _.assign(
            { page: _.toNumber(pageNumber) + 1, per_page: pageSize },
            queries
          )
        );
        const response = await axios.get(`${url}?${mergedQueries}`);
        results.push(...response.data.data);
        relationships.push(...(response.data.included ?? []));
      },
      5
    );
  }
  if (included) {
    _.each(results, (result) => {
      if (result.relationships) {
        _.forIn(result.relationships, (relationship) => {
          const { type, id } = relationship.data;
          const selectedRelationship = _.find(relationships, { type, id });
          if (selectedRelationship) {
            relationship.data.attributes = selectedRelationship.attributes;
          }
        });
      }
    });
  }
  return results;
}

async function fetchAccessToken() {
  const begin = moment();
  const appKey = process.env.APP_KEY;
  const appSecret = process.env.APP_SECRET;
  const params = {
    grant_type: "client_credentials",
    app_key: appKey,
    app_secret: appSecret,
  };
  const response = await axios.default.post(`${issuer}/token`, params);
  const accessToken = response.data.access_token;
  const duration = moment().diff(begin, "milliseconds");
  console.log(
    `Fetched access token successfully, it cost ${duration} milliseconds!`
  );
  return accessToken;
}

function setAuthorization(accessToken) {
  axios.defaults.headers.common["Authorization"] = `Bearer ${accessToken}`;
  console.log(`Setted access token successfully!`);
}

async function generateDirectoryMap(categoryIds) {
  const begin = moment();
  const directoryMap = new Map();
  let hierarchy = 1;
  directoryMap.append = (directory, parentId) => {
    const directoryId = _.get(directory, "id");
    let directoryName = _.get(directory, "attributes.name");
    if (parentId) {
      directoryName = `${directoryMap.get(parentId)}@${directoryName}`;
    }
    directoryMap.set(directoryId, directoryName);
  };
  const fetchSubDirectories = async (parentDirectories) => {
    if (parentDirectories.length === 0) {
      return;
    }
    const begin = moment();
    const subDirectories = await asyncPool(
      parentDirectories,
      (parentDirectory) =>
        fetchAllData(`${apiIssuer}/directories`, {
          team_id: parentDirectory.attributes.team_id,
          directory_id: parentDirectory.id,
        }).then((subDirectories) =>
          _.each(subDirectories, (subDirectory) => {
            directoryMap.append(subDirectory, parentDirectory.id);
            subDirectory.attributes.team_id =
              parentDirectory.attributes.team_id;
          })
        )
    ).then(_.flatMap);
    const duration = moment().diff(begin, "milliseconds");
    console.log(
      `Fetched hierarchy ${hierarchy++} directories successfully, it cost ${duration} milliseconds!`
    );
    await fetchSubDirectories(subDirectories);
  };
  const rootDirectories = await asyncPool(categoryIds, (categoryId) =>
    fetchAllData(`${apiIssuer}/directories`, {
      team_id: categoryId,
    }).then((rootDirectories) =>
      _.each(rootDirectories, (rootDirectory) => {
        directoryMap.append(rootDirectory);
        rootDirectory.attributes.team_id = categoryId;
      })
    )
  ).then(_.flatMap);
  let duration = moment().diff(begin, "milliseconds");
  console.log(
    `Fetched root directories successfully, it cost ${duration} milliseconds!`
  );
  await fetchSubDirectories(rootDirectories);
  duration = moment().diff(begin, "milliseconds");
  console.log(
    `Generated directory map successfully, it cost ${duration} milliseconds!`
  );
  return directoryMap;
}

async function fetchDocuments(categoryIds) {
  const begin = moment();
  const listType = process.env.DOCUMENT_LIST_TYPE;
  const categoryDocuments = await asyncPool(categoryIds, (categoryId) =>
    fetchAllData(
      `${apiIssuer}/docs`,
      {
        list_type: listType,
        team_id: categoryId,
      },
      true
    )
  );
  const documents = _.flatMap(categoryDocuments);
  const duration = moment().diff(begin, "milliseconds");
  console.log(
    `Fetched documents successfully, it cost ${duration} milliseconds!`
  );
  return documents;
}

function generateExcel(documents, directoryMap) {
  const begin = moment();
  const aoa = [];
  aoa.push([
    "Doc ID",
    "Doc Folder Route",
    "Doc Name",
    "Creator ID",
    "Creator Name",
    "Creator Organization",
    "Create Time",
    "Updated Time",
    "Start",
    "Read Count",
    "Comment Count",
    "Like Count",
    "Favorite Count",
    "Recommended At",
  ]);
  _.each(documents, (document) => {
    aoa.push([
      _.get(document, "id"),
      directoryMap.get(_.get(document, "relationships.directory.data.id")) ??
        "",
      _.get(document, "attributes.name"),
      _.get(document, "relationships.owner.data.id"),
      _.get(document, "relationships.owner.data.attributes.name"),
      _.get(document, "relationships.owner.data.attributes.organization"),
      _.get(document, "attributes.created_at"),
      _.get(document, "attributes.updated_at"),
      _.get(document, "attributes.is_star") === 0 ? "No" : "Yes",
      _.get(document, "attributes.read_count"),
      _.get(document, "attributes.comment_count"),
      _.get(document, "relationships.target.data.attributes.like_count"),
      _.get(document, "relationships.target.data.attributes.favorite_count"),
      _.get(document, "attributes.recommended_at"),
    ]);
  });
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  const stream = xlsx.stream.to_csv(worksheet);
  const duration = moment().diff(begin, "milliseconds");
  console.log(
    `Generated excel successfully, it cost ${duration} milliseconds!`
  );
  return stream;
}

function saveFile(stream, fileName) {
  const filePath = path.join(process.cwd(), fileName);
  stream.pipe(fs.WriteStream(filePath));
}

async function uploadFile(stream, fileName) {
  const begin = moment();
  const host = _.toString(process.env.SFTP_HOST);
  const port = _.toNumber(process.env.SFTP_PORT);
  const username = _.toString(process.env.SFTP_USERNAME);
  const password = _.toString(process.env.SFTP_PASSWORD);
  const filePath = path.join(process.env.SFTP_PATH, fileName);
  const client = new SFTPClient({ host, port, username, password });
  let duration = moment().diff(begin, "milliseconds");
  console.log(`Connected sftp successfully, it cost ${duration} milliseconds!`);
  await client.put(stream, filePath);
  duration = moment().diff(begin, "milliseconds");
  console.log(`Uploaded file successfully, it cost ${duration} milliseconds!`);
}

exports.handler = async function (event, context) {
  try {
    const begin = moment();
    setHttpsProxyAgent();
    const accessToken = await fetchAccessToken();
    setAuthorization(accessToken);
    const categoryIds = _.split(process.env.CATEGORY_IDS, ",");
    const directoryMap = await generateDirectoryMap(categoryIds);
    const documents = await fetchDocuments(categoryIds);
    const stream = generateExcel(documents, directoryMap);
    const fileName = `YEYX_document_${moment().format("YYYYMMDD")}.csv`;
    if (isLocal()) {
      saveFile(stream, fileName);
    } else {
      await uploadFile(stream, fileName);
    }
    const duration = moment().diff(begin, "seconds");
    console.log(`Handler execution successfully, it cost ${duration} seconds!`);
    return {
      statusCode: 200,
      body: "ok",
    };
  } catch (error) {
    console.error("Exception occurred: ", getErrorMessage(error));
    return {
      statusCode: 500,
      body: "Internal Server Error",
    };
  }
};

if (isLocal()) {
  this.handler();
}
