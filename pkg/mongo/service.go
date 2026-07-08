package mongo

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

type Service interface {
	Find(ctx context.Context, collection string, filter, result interface{}, opts ...*options.FindOptions) error
	Insert(ctx context.Context, collection string, documents interface{}, opts ...*options.InsertManyOptions) ([]ObjectID, error)
	Update(ctx context.Context, collection string, filter, update interface{}, opts ...*options.UpdateOptions) error
	FindOneAndUpdate(ctx context.Context, collection string, filter, update, result interface{}, opts ...*options.FindOneAndUpdateOptions) error
	BulkUpsert(ctx context.Context, collection string, filters, updates []interface{}) error
	Transaction(ctx context.Context, fn func(tx Service) error) error
}

var ErrNoFilter = errors.New("no filter criteria provided")
var ErrMismatchedBulk = errors.New("filters and updates must have the same length")
var ErrNestedTransaction = errors.New("nested transactions are not supported")

type D = bson.D
type E = bson.E
type A = bson.A
type M = bson.M

type ObjectID = primitive.ObjectID

func NewObjectId() ObjectID {
	return primitive.NewObjectID()
}

func NewService(config map[string]interface{}, logger logger.Logger) Service {
	return &service{
		logger: logger,
		database: connect(
			config["mongo_host"].(string),
			config["mongo_port"].(string),
			config["mongo_database"].(string),
		),
	}
}

type service struct {
	logger logger.Logger

	database *mongo.Database
}

func connect(host, port, database string) *mongo.Database {
	client, err := mongo.Connect(
		context.TODO(),
		options.Client().ApplyURI(fmt.Sprintf("mongodb://%s%s%s", host, ":", port)),
	)
	if err != nil {
		panic("connecting to mongo: " + err.Error())
	}

	if err := client.Ping(context.TODO(), readpref.Primary()); err != nil {
		panic("checking mongo connection: " + err.Error())
	}

	return client.Database(database)
}

// validateFilter rejects nil and empty map/slice filters (M, D); other
// filter types pass through to the driver.
func validateFilter(filter interface{}) error {
	v := reflect.ValueOf(filter)
	if !v.IsValid() ||
		((v.Kind() == reflect.Map || v.Kind() == reflect.Slice) && v.Len() == 0) {
		return ErrNoFilter
	}

	return nil
}

func (this service) Find(ctx context.Context, collection string, filter, result interface{}, opts ...*options.FindOptions) error {
	if err := validateFilter(filter); err != nil {
		return err
	}

	cursor, err := this.database.Collection(collection).Find(ctx, filter, opts...)
	if err != nil {
		return err
	}

	err = cursor.All(ctx, result)
	if err != nil {
		return err
	}

	return nil
}

func (this service) Insert(ctx context.Context, collection string, documents interface{}, opts ...*options.InsertManyOptions) ([]ObjectID, error) {
	var documentsToInsert []interface{}

	if reflect.ValueOf(documents).Kind() != reflect.Slice {
		documentsToInsert = []interface{}{documents}
	} else {
		docs := reflect.ValueOf(documents)

		for i := 0; i < docs.Len(); i++ {
			documentsToInsert = append(documentsToInsert, docs.Index(i).Interface())
		}
	}

	cursor, err := this.database.Collection(collection).InsertMany(ctx, documentsToInsert, opts...)
	if err != nil {
		return nil, err
	}

	insertedIds := make([]ObjectID, len(cursor.InsertedIDs))
	for i, v := range cursor.InsertedIDs {
		// user-supplied _ids may not be ObjectIDs; those slots stay zero
		if id, ok := v.(ObjectID); ok {
			insertedIds[i] = id
		}
	}

	return insertedIds, nil
}

func (this service) Update(ctx context.Context, collection string, filter, update interface{}, opts ...*options.UpdateOptions) error {
	_, err := this.database.Collection(collection).UpdateMany(ctx, filter, update, opts...)
	if err != nil {
		return err
	}

	return nil
}

func (this service) FindOneAndUpdate(ctx context.Context, collection string, filter, update, result interface{}, opts ...*options.FindOneAndUpdateOptions) error {
	cursor := this.database.Collection(collection).FindOneAndUpdate(ctx, filter, update, opts...)
	if cursor.Err() != nil {
		return cursor.Err()
	}

	err := cursor.Decode(result)
	if err != nil {
		return err
	}

	return nil
}

// BulkUpsert applies updates[i] to the document matching filters[i],
// inserting when unmatched; atomic only inside a Transaction.
func (this service) BulkUpsert(ctx context.Context, collection string, filters, updates []interface{}) error {
	if len(filters) != len(updates) {
		return ErrMismatchedBulk
	}
	if len(filters) == 0 {
		return nil
	}

	models := make([]mongo.WriteModel, len(filters))
	for i := range filters {
		if err := validateFilter(filters[i]); err != nil {
			return err
		}

		models[i] = mongo.NewUpdateOneModel().
			SetFilter(filters[i]).
			SetUpdate(updates[i]).
			SetUpsert(true)
	}

	_, err := this.database.Collection(collection).BulkWrite(ctx, models)

	return err
}

// Transaction runs fn atomically; use fn's tx-bound Service inside the
// callback. Requires a replica set; do not nest. fn may run more than
// once on transient errors, so it must be idempotent.
func (this service) Transaction(ctx context.Context, fn func(tx Service) error) error {
	session, err := this.database.Client().StartSession()
	if err != nil {
		return err
	}
	defer session.EndSession(ctx)

	_, err = session.WithTransaction(ctx, func(_ mongo.SessionContext) (interface{}, error) {
		return nil, fn(&txService{service: this, session: session})
	})

	return err
}

// txService rebinds each call's ctx to the transaction session.
type txService struct {
	service
	session mongo.Session
}

func (this *txService) Find(ctx context.Context, collection string, filter, result interface{}, opts ...*options.FindOptions) error {
	return this.service.Find(mongo.NewSessionContext(ctx, this.session), collection, filter, result, opts...)
}

func (this *txService) Insert(ctx context.Context, collection string, documents interface{}, opts ...*options.InsertManyOptions) ([]ObjectID, error) {
	return this.service.Insert(mongo.NewSessionContext(ctx, this.session), collection, documents, opts...)
}

func (this *txService) Update(ctx context.Context, collection string, filter, update interface{}, opts ...*options.UpdateOptions) error {
	return this.service.Update(mongo.NewSessionContext(ctx, this.session), collection, filter, update, opts...)
}

func (this *txService) FindOneAndUpdate(ctx context.Context, collection string, filter, update, result interface{}, opts ...*options.FindOneAndUpdateOptions) error {
	return this.service.FindOneAndUpdate(mongo.NewSessionContext(ctx, this.session), collection, filter, update, result, opts...)
}

func (this *txService) BulkUpsert(ctx context.Context, collection string, filters, updates []interface{}) error {
	return this.service.BulkUpsert(mongo.NewSessionContext(ctx, this.session), collection, filters, updates)
}

func (this *txService) Transaction(ctx context.Context, fn func(tx Service) error) error {
	return ErrNestedTransaction
}
